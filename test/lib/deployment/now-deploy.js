const assert = require('assert');
const { createHash } = require('crypto');
const path = require('path');
const _fetch = require('node-fetch');
const fetch = require('./fetch-retry.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function nowDeploy(bodies, randomness) {
  const files = Object.keys(bodies)
    .filter(n => n !== 'now.json')
    .map(n => ({
      sha: digestOfFile(bodies[n]),
      size: bodies[n].length,
      file: n,
      mode: path.extname(n) === '.sh' ? 0o100755 : 0o100644,
    }));

  const { FORCE_BUILD_IN_REGION, NOW_DEBUG } = process.env;
  const nowJson = JSON.parse(bodies['now.json']);

  const nowDeployPayload = {
    version: 2,
    public: true,
    env: { ...nowJson.env, RANDOMNESS_ENV_VAR: randomness },
    build: {
      env: {
        ...(nowJson.build || {}).env,
        RANDOMNESS_BUILD_ENV_VAR: randomness,
        FORCE_BUILD_IN_REGION,
        NOW_DEBUG,
      },
    },
    name: 'test2020',
    files,
    builds: nowJson.builds,
    routes: nowJson.routes || [],
    meta: {},
  };

  console.log(`posting ${files.length} files`);

  for (const { file: filename } of files) {
    await filePost(bodies[filename], digestOfFile(bodies[filename]));
  }

  let deploymentId;
  let deploymentUrl;

  {
    const json = await deploymentPost(nowDeployPayload);
    if (json.error && json.error.code === 'missing_files')
      throw new Error('Missing files');
    deploymentId = json.id;
    deploymentUrl = json.url;
  }

  console.log('id', deploymentId);
  console.log('deploymentUrl', `https://${deploymentUrl}`);

  for (let i = 0; i < 750; i += 1) {
    const { state } = await deploymentGet(deploymentId);
    if (state === 'ERROR')
      throw new Error(`State of ${deploymentUrl} is ${state}`);
    if (state === 'READY') break;
    await new Promise(r => setTimeout(r, 1000));
  }

  return { deploymentId, deploymentUrl };
}

function digestOfFile(body) {
  return createHash('sha1')
    .update(body)
    .digest('hex');
}

async function filePost(body, digest) {
  assert(Buffer.isBuffer(body));

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'x-now-digest': digest,
    'x-now-size': body.length,
  };

  const url = '/v2/now/files';

  const resp = await fetchWithAuth(url, {
    method: 'POST',
    headers,
    body,
  });

  const json = await resp.json();

  if (json.error) {
    const { status, statusText, headers } = resp;
    const { message } = json.error;
    console.log('Fetch Error', { url, status, statusText, headers, digest });
    throw new Error(message);
  }
  return json;
}

async function deploymentPost(payload) {
  const url = '/v6/now/deployments?forceNew=1';
  const resp = await fetchWithAuth(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const json = await resp.json();

  if (json.error) {
    const { status, statusText, headers } = resp;
    const { message } = json.error;
    console.log('Fetch Error', { url, status, statusText, headers });
    throw new Error(message);
  }
  return json;
}

async function deploymentGet(deploymentId) {
  const url = `/v3/now/deployments/${deploymentId}`;
  const resp = await fetchWithAuth(url);
  const json = await resp.json();
  if (json.error) {
    const { status, statusText, headers } = resp;
    const { message } = json.error;
    console.log('Fetch Error', { url, status, statusText, headers });
    throw new Error(message);
  }
  return json;
}

let token;
let currentCount = 0;
const MAX_COUNT = 10;

async function fetchWithAuth(url, opts = {}) {
  if (!opts.headers) opts.headers = {};

  if (!opts.headers.Authorization) {
    currentCount += 1;
    if (!token || currentCount === MAX_COUNT) {
      currentCount = 0;
      if (process.env.NOW_TOKEN) {
        // used for health checks
        token = process.env.NOW_TOKEN;
      } else {
        // used by GH Actions
        token = await fetchTokenWithRetry();
      }
    }

    opts.headers.Authorization = `Bearer ${token}`;
  }

  return await fetchApi(url, opts);
}

async function fetchTokenWithRetry(retries = 5) {
  const { NOW_TOKEN, ZEIT_TEAM_TOKEN, ZEIT_REGISTRATION_URL } = process.env;
  if (NOW_TOKEN) {
    console.log('Using NOW_TOKEN for test deployment');
    return NOW_TOKEN;
  }
  if (!ZEIT_TEAM_TOKEN || !ZEIT_REGISTRATION_URL) {
    throw new Error(
      'Failed to create test deployment. Did you forget to set NOW_TOKEN?'
    );
  }
  try {
    const res = await _fetch(ZEIT_REGISTRATION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZEIT_TEAM_TOKEN}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Unexpected status from registration: ${res.status}`);
    }
    const data = await res.json();
    if (!data) {
      throw new Error(`Unexpected response from registration: no body`);
    }
    if (!data.token) {
      const text = JSON.stringify(data);
      throw new Error(`Unexpected response from registration: ${text}`);
    }
    return data.token;
  } catch (error) {
    console.log(`Failed to fetch token. Retries remaining: ${retries}`);
    if (retries === 0) {
      console.log(error);
      throw error;
    }
    await sleep(500);
    return fetchTokenWithRetry(retries - 1);
  }
}

async function fetchApi(url, opts = {}) {
  const apiHost = process.env.API_HOST || 'api.zeit.co';
  const urlWithHost = `https://${apiHost}${url}`;
  const { method = 'GET', body } = opts;

  if (process.env.VERBOSE) {
    console.log('fetch', method, url);
    if (body) console.log(encodeURIComponent(body).slice(0, 80));
  }

  if (!opts.headers) opts.headers = {};

  if (!opts.headers.Accept) {
    opts.headers.Accept = 'application/json';
  }

  opts.headers['x-now-trace-priority'] = '1';

  return await fetch(urlWithHost, opts);
}

module.exports = {
  fetchApi,
  fetchWithAuth,
  nowDeploy,
  fetchTokenWithRetry,
};
