'use strict';

const defaultCloud = require('./species-cloud');
const defaultStore = require('./species-store');
const { scopeOf, sameScope } = require('./species-scope');
const { runCombinedRecognition } = require('./species-orchestration');

function uploadWarning(detection) {
  if (detection?.status !== 'complete') return '人体与头部检测不可用，不能判断切图中是否有人。';
  if (detection.headDetected || detection.personDetected)
    return '切图检测到疑似人体或头部，可能包含隐私信息。';
  return '切图未检出人体或头部，但模型可能漏检。';
}

function registerSpeciesIpc({
  handle,
  bridge,
  coordinator,
  dialog,
  getWindow,
  getSpeciesDirectory,
  getCredentials,
  cloud = defaultCloud,
  store = defaultStore,
  combine = runCombinedRecognition,
}) {
  handle('species:credential-status', () => getCredentials().status());
  handle('species:credential-save', (key) =>
    coordinator.runExclusive(() => getCredentials().save(key), '树种分析进行中，请稍候。'),
  );
  handle('species:credential-clear', () =>
    coordinator.runExclusive(async () => {
      const choice = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: '删除本机保存的密钥',
        message: '是否删除当前 Windows 用户下保存的 DeepSeek 密钥？',
        detail: '这不会撤销服务商账户中的密钥；如密钥泄漏，请另行在服务商处撤销。',
        buttons: ['取消', '删除本机密钥'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response !== 1) return { cancelled: true };
      return getCredentials().clear();
    }, '树种分析进行中，请稍候。'),
  );
  handle('species:catalog', () => cloud.catalog);
  handle('species:context', async () => {
    const snapshot = await bridge.call('recognition.snapshot');
    let record = null;
    let recordError = '';
    try {
      record = await store.readSpecies(getSpeciesDirectory(), snapshot);
    } catch {
      recordError = '已保存记录损坏或不可读取；仍可分析，但不能覆盖该记录。';
    }
    return { scope: scopeOf(snapshot), record, recordError };
  });
  handle('species:preview', async (expected) => {
    const generation = coordinator.beginPreview();
    const snapshot = await bridge.call('recognition.snapshot');
    if (!sameScope(snapshot, expected)) throw new Error('数据或切图已变化，请重新核查。');
    const scope = coordinator.finishPreview(generation, scopeOf(snapshot));
    return { image: snapshot.image, peopleDetection: snapshot.peopleDetection, scope };
  });
  handle('species:cancel-preview', () => coordinator.cancelPreview());

  handle('species:save', (selection) =>
    coordinator.runExclusive(async () => {
      const snapshot = await bridge.call('recognition.snapshot');
      const choice = store.validateSelection(snapshot, selection);
      const previous = await store.readSpecies(getSpeciesDirectory(), snapshot);
      const confirmation = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: '确认保存人工树种',
        message: `确认将树 #${snapshot.treeId}（序号 ${snapshot.treeIndex}）标记为“${choice.name}”？`,
        detail: previous
          ? `当前已有人工确认“${previous.choice.name}”；继续将保留旧记录备份。切图 SHA-256：${snapshot.imageSha256}`
          : `记录将单独保存，不修改原始树木文件。切图 SHA-256：${snapshot.imageSha256}`,
        buttons: ['取消', '确认保存'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { cancelled: true };
      const current = await bridge.call('recognition.snapshot');
      if (!sameScope(current, selection.scope)) throw new Error('数据或切图已变化，请重新确认。');
      return store.saveSpecies(getSpeciesDirectory(), current, selection, {
        expectedRevision: store.recordRevision(previous),
      });
    }),
  );

  handle('species:analyze', (request) => {
    coordinator.assertIdle('已有树种确认正在进行。');
    if (request?.reviewConfirmed !== true) throw new Error('上传前请先人工核查切图。');
    return coordinator.runExclusive(async () => {
      try {
        const snapshot = await bridge.call('recognition.snapshot');
        if (!sameScope(snapshot, request.scope) || !sameScope(snapshot, coordinator.previewScope))
          throw new Error('数据、树木、帧或切图已变化，请重新预览后再上传。');
        coordinator.cancelPreview();
        const confirmation = await dialog.showMessageBox(getWindow(), {
          type: 'warning',
          title: '确认上传当前切图',
          message: uploadWarning(snapshot.peopleDetection),
          detail:
            '仅上传当前树木的干净切图至 DeepSeek，随后发送本地和视觉识别的文字结果进行综合复核；不会主动上传全景、坐标、文件路径或其他图片。云端可能产生费用，请人工检查画面及服务商隐私与计费规则。确认后才联网。',
          buttons: ['取消', '已核查并同意上传'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) return { cancelled: true };
        const current = await bridge.call('recognition.snapshot');
        if (!sameScope(current, request.scope)) throw new Error('切图已变化，请重新核查后再上传。');
        const key = await getCredentials().read();
        const result = await combine({
          local: () => bridge.call('recognize'),
          visual: () => cloud.analyzeVisual({ key, image: snapshot.image }),
          synthesize: (local, visual) =>
            cloud.synthesizeSpecies({ key, localText: local.text, visual }),
        });
        return { ...result, model: cloud.MODEL, scope: scopeOf(snapshot) };
      } finally {
        coordinator.cancelPreview();
      }
    });
  });
}

module.exports = { registerSpeciesIpc, uploadWarning };
