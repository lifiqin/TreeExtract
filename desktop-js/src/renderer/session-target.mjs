// 只标识当前数据/树/帧；视角变化不等于切换目标，切图身份另由后端摘要校验。
export function sessionTarget(state, current = state.current) {
  return JSON.stringify([
    state.sessionGeneration || 0,
    current?.dataDir,
    current?.zipPath,
    current?.treeIndex,
    current?.treeId,
    current?.frame,
  ]);
}
