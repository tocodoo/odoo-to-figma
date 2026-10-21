'use strict';
// Queue of captures waiting to be built by the Figma plugin.
// The plugin listens on GET /figma/events (Server-Sent Events), downloads each
// job, builds it, and posts the result back; callers can wait for that result.

const jobs = new Map();
const clients = new Set();
let seq = 0;

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* client gone */ }
}

function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

/** Add a capture to the queue. opts: { name, autoLayout } */
function add(capture, opts = {}) {
  const id = `job-${++seq}-${Date.now().toString(36)}`;
  const job = {
    id, name: opts.name || (capture.meta && (capture.meta.name || capture.meta.title)) || 'Import',
    autoLayout: opts.autoLayout, capture, status: 'queued', created: Date.now(), result: null, waiters: [],
  };
  jobs.set(id, job);
  broadcast('job', { id, name: job.name });
  // forget finished jobs after a while
  for (const [k, j] of jobs) if (j.status === 'done' && Date.now() - j.created > 15 * 60e3) jobs.delete(k);
  return job;
}

/** Wait until the plugin reports the job built (or `ms` elapses). */
function wait(job, ms) {
  if (job.status === 'done' || job.status === 'error') return Promise.resolve(job);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { job.waiters = job.waiters.filter((w) => w !== done); resolve(job); }, ms);
    const done = () => { clearTimeout(timer); resolve(job); };
    job.waiters.push(done);
  });
}

function pending() {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'sent');
}

/** GET /figma/events */
function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true',
  });
  res.write(': connected\n\n');
  clients.add(res);
  for (const j of pending()) send(res, 'job', { id: j.id, name: j.name });
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 15000);
  req.on('close', () => { clearInterval(beat); clients.delete(res); });
}

/** GET /figma/jobs/:id */
function fetchJob(id) {
  const job = jobs.get(id);
  if (!job || !job.capture) return null;
  job.status = 'sent';
  return { id: job.id, name: job.name, autoLayout: job.autoLayout, capture: job.capture };
}

/** POST /figma/jobs/:id/result */
function complete(id, result) {
  const job = jobs.get(id);
  if (!job) return false;
  job.status = result && result.ok ? 'done' : 'error';
  job.result = result || {};
  job.capture = null; // free the memory
  job.waiters.splice(0).forEach((w) => w());
  broadcast('done', { id, ok: job.status === 'done' });
  return true;
}

function status() {
  return { pluginConnected: clients.size > 0, plugins: clients.size, pending: pending().map((j) => ({ id: j.id, name: j.name, status: j.status })) };
}

module.exports = { add, wait, subscribe, fetchJob, complete, status };
