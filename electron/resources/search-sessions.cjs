const sessions = new Map();

function startSearch(sender, scope) {
  const key = `${sender.id}:${scope}`;
  sessions.get(key)?.abort();
  const controller = new AbortController();
  sessions.set(key, controller);
  const destroy = () => controller.abort();
  sender.once('destroyed', destroy);
  return { signal: controller.signal, finish() {
    sender.removeListener('destroyed', destroy);
    if (sessions.get(key) === controller) sessions.delete(key);
  } };
}
function cancelSearch(sender, scope) { sessions.get(`${sender.id}:${scope}`)?.abort(); }

module.exports = { startSearch, cancelSearch };
