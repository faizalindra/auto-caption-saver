// Turns transcript text into a blob: URL for chrome.downloads (service workers
// cannot call URL.createObjectURL, and data: URLs break on long meetings).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'blob') {
    const url = URL.createObjectURL(new Blob([msg.text], { type: 'text/plain;charset=utf-8' }));
    // Fallback in case the service worker restarts and forgets to revoke it.
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    reply({ url });
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.url);
  }
});
