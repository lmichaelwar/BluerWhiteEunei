export function connectionStatus(h) {
  if (h.available === true && h.model === 'gpt-6-luna') return h.verified_inference === true
    ? 'Luna connected · live dialogue' : 'Luna ready · awaiting first scene';
  const retry = Number(h.retry_after);
  const wait = Number.isFinite(retry) && retry > 0 ? ` · resumes in ${Math.ceil(retry / 60)} min` : '';
  if (h.code === 'local_hour_budget') return `Office hourly limit · rule-based behavior${wait}`;
  if (h.code === 'local_minute_budget' || h.code === 'local_scene_pacing') return `Office pacing · rule-based behavior${wait}`;
  if (h.status === 'quota') return `ChatGPT plan quota paused · rule-based behavior${wait}`;
  if (h.status === 'auth_required') return 'Sign in to enable Luna · rule-based behavior';
  return 'Luna unavailable · rule-based behavior';
}
