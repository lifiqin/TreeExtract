import { ImageSafetyGate } from './image-safety-gate.mjs';
import { sessionTarget } from './session-target.mjs';

// 将模型建议和人工结果分离；切图变化时不沿用旧模型建议。
export function createSpeciesReview({ element, api, state, execute }) {
  let target = '';
  let scope = '';
  let generation = 0;
  let context = null;
  let draftDirty = false;
  let analysisPending = false;
  let credentialConfigured = false;
  const drafts = new Map();
  const previewGate = new ImageSafetyGate();
  const node = (name) => element(`species-${name}`);

  function rememberDraft() {
    if (scope && draftDirty)
      drafts.set(scope, { value: node('choice').value, otherName: node('other').value });
  }

  function showOtherInput() {
    const other = node('choice').value === '__other__';
    node('other').hidden = !other;
    node('other-label').hidden = !other;
  }

  function clearRecommendations() {
    context = null;
    draftDirty = false;
    node('key').value = '';
    node('reviewed').checked = false;
    node('choice').value = '';
    node('other').value = '';
    node('other').hidden = true;
    node('other-label').hidden = true;
    node('visual').textContent = '云端视觉：尚未请求';
    node('synthesis').textContent = '综合复核：尚未请求';
    node('final').textContent = '最终模型建议：尚未生成';
    node('saved').textContent = '尚无已保存的人工确认';
  }

  function onState(current) {
    const next = current?.loaded ? sessionTarget(state, current) : '';
    if (target === next) return;
    rememberDraft();
    target = next;
    scope = '';
    generation += 1;
    clearRecommendations();
  }

  async function update(current, crop) {
    onState(current);
    const turn = ++generation;
    if (!target || !crop) {
      rememberDraft();
      scope = '';
      clearRecommendations();
      return;
    }
    try {
      const value = await api.speciesContext();
      if (turn !== generation) return;
      const next = JSON.stringify(value.scope);
      if (next !== scope) {
        rememberDraft();
        scope = next;
        clearRecommendations();
        const draft = drafts.get(scope);
        if (draft) {
          node('choice').value = draft.value;
          node('other').value = draft.otherName;
          draftDirty = true;
          showOtherInput();
        }
      }
      context = value;
      if (value.recordError) node('saved').textContent = value.recordError;
      else if (value.record) {
        node('saved').textContent =
          `已保存人工确认：${value.record.choice.name}\n原确认切图：${value.record.imageSha256 === value.scope.imageSha256 ? '当前切图' : '其他切图'}`;
      } else node('saved').textContent = '尚无已保存的人工确认';
    } catch {
      if (turn === generation) {
        rememberDraft();
        scope = '';
        clearRecommendations();
        node('saved').textContent = '无法读取当前切图身份；若数据已改变，请重新加载。';
      }
    }
  }

  async function initialize() {
    const groups = await api.speciesCatalog();
    const select = node('choice');
    for (const group of groups) {
      const section = document.createElement('optgroup');
      section.label = group.name;
      for (const entry of group.entries) {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.name;
        section.append(option);
      }
      select.append(section);
    }
    for (const [value, label] of [
      ['__uncertain__', '不确定'],
      ['__other__', '列表外'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    await refreshCredentialStatus();
  }

  async function refreshCredentialStatus() {
    try {
      const status = await api.speciesCredentialStatus();
      credentialConfigured = Boolean(status.available && status.configured && !status.damaged);
      node('key-status').textContent = !status.available
        ? 'Windows 安全存储不可用；仍可使用本地识别。'
        : status.damaged
          ? '本机密钥无法读取或解密，请检查配置。'
          : credentialConfigured
            ? '已在当前 Windows 用户下加密保存，无需重复输入。'
            : '尚未配置；保存一次后可自动发起联合识别。';
    } catch {
      credentialConfigured = false;
      node('key-status').textContent = '无法检查本机密钥；仍可使用本地识别。';
    }
  }

  node('key-save').addEventListener('click', async () => {
    let secret = node('key').value.trim();
    node('key').value = '';
    if (!secret) {
      node('key-status').textContent = '请输入新的 API 密钥后再保存。';
      return;
    }
    try {
      const pending = api.speciesCredentialSave(secret);
      secret = '';
      await pending;
      await refreshCredentialStatus();
    } catch {
      node('key-status').textContent = '密钥未能安全保存，请检查 Windows 用户账户与存储权限。';
    } finally {
      secret = '';
    }
  });
  node('key-clear').addEventListener('click', async () => {
    try {
      const result = await api.speciesCredentialClear();
      if (!result?.cancelled) await refreshCredentialStatus();
    } catch {
      node('key-status').textContent = '无法删除本机密钥，请检查存储权限。';
    }
  });

  node('choice').addEventListener('change', () => {
    draftDirty = true;
    showOtherInput();
  });
  node('other').addEventListener('input', () => {
    draftDirty = true;
  });

  function updatePreviewAction() {
    node('preview-approve').disabled = !node('reviewed').checked || !node('preview-cover').hidden;
  }
  node('reviewed').addEventListener('change', updatePreviewAction);
  node('preview-reveal').addEventListener('click', () => {
    const image = previewGate.reveal();
    if (!image) return;
    node('preview-image').src = image;
    node('preview-image').classList.add('visible');
    node('preview-cover').hidden = true;
    updatePreviewAction();
  });
  node('preview-cancel').addEventListener('click', () => node('preview-dialog').close('cancel'));
  node('preview-approve').addEventListener('click', () => {
    if (!node('preview-approve').disabled) node('preview-dialog').close('approved');
  });

  async function reviewUpload(expected) {
    const preview = await execute('正在准备干净切图预览…', () => api.speciesPreview(expected), {
      images: false,
    });
    if (!preview || JSON.stringify(preview.scope) !== JSON.stringify(expected)) return false;
    const result = previewGate.update(preview.image, preview.peopleDetection);
    const image = node('preview-image');
    if (result.image) image.src = result.image;
    else image.removeAttribute('src');
    image.classList.toggle('visible', Boolean(result.image));
    node('preview-cover').hidden = !result.blocked;
    const detection = preview.peopleDetection;
    node('preview-note').textContent =
      detection?.status !== 'complete'
        ? '人体及头部检测不可用，不能排除人员或头皮。'
        : result.blocked
          ? '检测到疑似人体或头部；模型可能误报或漏报。'
          : '未检出人体或头部，但模型可能漏检。';
    node('reviewed').checked = false;
    updatePreviewAction();
    const dialog = node('preview-dialog');
    dialog.returnValue = '';
    const approved = await new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'approved'), {
        once: true,
      });
      dialog.showModal();
    });
    image.removeAttribute('src');
    image.classList.remove('visible');
    previewGate.update(null, null);
    if (!approved) await api.speciesCancelPreview().catch(() => {});
    return approved;
  }

  async function localOnly() {
    return execute('本地模型识别并生成热力图中，请稍候…', () => api.recognize(), {
      success: '本地识别与热力图已完成。',
    });
  }

  async function run() {
    if (analysisPending || state.busy || !state.current?.loaded) return;
    analysisPending = true;
    element('recognize').setAttribute('aria-busy', 'true');
    node('visual').textContent = '云端视觉：本轮尚未完成';
    node('synthesis').textContent = '综合复核：本轮尚未完成';
    node('final').textContent = '正在开始本轮识别…';
    try {
      if (!context || !credentialConfigured) {
        const local = await localOnly();
        node('final').textContent = !local
          ? '本地识别未完成，请检查数据和模型。'
          : !credentialConfigured
            ? '本地识别已完成；配置本机密钥后可同时使用云端分级复核。'
            : '本地识别已完成；当前切图身份不可用，无法发起云端复核。';
        return;
      }
      const expected = context.scope;
      if (!(await reviewUpload(expected))) {
        const local = await localOnly();
        node('final').textContent = local
          ? '已取消云端上传；本地识别已完成。'
          : '已取消云端上传，且本地识别未完成。';
        return;
      }
      const result = await execute('正在并行运行本地与云端识别，再进行综合复核…', () =>
        api.speciesAnalyze(true, expected),
      );
      if (!result || result.cancelled) {
        const local = await localOnly();
        if (result?.cancelled)
          node('final').textContent = local
            ? '已取消云端上传；本地识别已完成。'
            : '已取消云端上传，且本地识别未完成。';
        else
          node('final').textContent = local
            ? '云端联合识别未完成；本地识别已完成，请检查密钥或网络。'
            : '本地与云端识别均未完成。';
        return;
      }
      if (!context || JSON.stringify(result.scope) !== JSON.stringify(expected)) return;
      const visual = result.visual;
      if (!visual) {
        node('visual').textContent = result.visualError || '云端视觉识别未完成。';
        node('synthesis').textContent = result.synthesisError || '综合复核未完成。';
        node('final').textContent = result.localCompleted
          ? '最终模型建议：未生成；请参考本地识别并人工判断。'
          : '本地与云端视觉均未完成，请检查模型和网络。';
        return;
      }
      const localName = result.localCompleted
        ? state.current?.recognition?.match(/^树种：([^（\r\n]+)/)?.[1]?.trim()
        : null;
      const nameComparison =
        !localName || !visual.candidate
          ? '名称比对：有结果不确定，不能比较。'
          : localName === visual.candidate.name
            ? '名称比对：名称相同，仍需人工核验。'
            : `名称比对：本地为“${localName}”，视觉为“${visual.candidate.name}”；名称不同，可能存在分类口径差异。`;
      node('visual').textContent =
        `云端视觉：${visual.candidate ? `${visual.candidate.group} → ${visual.candidate.name}` : '不确定或列表外'}\n${nameComparison}\n证据：${visual.reason || '未提供'}\n不确定性：${visual.uncertainty || '未提供'}`;
      const review = result.synthesis;
      node('final').textContent = review?.candidate
        ? `最终模型建议：${review.candidate.group} → ${review.candidate.name}（${review.candidate.value}）；请人工确认后保存。`
        : review
          ? '最终模型建议：不确定或列表外，请人工核查。'
          : '最终模型建议：未生成；请参考原始识别结果。';
      node('synthesis').textContent = review
        ? `综合复核（非独立投票）：${review.opinion || '未提供'}\n分歧：${review.differences || '未提供'}\n不确定性：${review.uncertainty || '未提供'}`
        : result.synthesisError;
    } catch {
      node('final').textContent = '无法完成联合识别，请检查密钥、网络与切图。';
      await api.speciesCancelPreview().catch(() => {});
    } finally {
      analysisPending = false;
      element('recognize').removeAttribute('aria-busy');
    }
  }

  node('save').addEventListener('click', async () => {
    if (!context) {
      node('saved').textContent = '请先选择可用的树木切图。';
      return;
    }
    const selection = {
      scope: context.scope,
      value: node('choice').value,
      otherName: node('other').value,
    };
    const result = await execute('正在保存人工确认…', () => api.speciesSave(selection), {
      images: false,
    });
    if (result && !result.cancelled) {
      drafts.delete(scope);
      draftDirty = false;
      node('saved').textContent =
        `已保存人工确认：${result.record.choice.name}\n记录：${result.path}${result.backupPath ? `\n旧记录备份：${result.backupPath}` : ''}`;
    }
  });

  return { initialize, update, onState, run };
}
