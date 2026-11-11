'use strict';
document.getElementById('open').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'FAB_HELPER_OPEN' });
    status.textContent = '已展开网页面板。';
  } catch { status.textContent = '请切换到 Fab 网页并刷新一次，再点击此按钮。'; }
});
