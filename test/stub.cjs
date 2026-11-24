// Preloaded into a script under test with NODE_OPTIONS, so that it and the refresh
// it starts meet a canned endpoint instead of the network:
//   STUB_REPLY    { status, body } as JSON, the endpoint's answer
//   STUB_LOG      file that gets one line of JSON for each request
//   STUB_MARK     file created when the script starts
//   STUB_CRASH    set to make a refresh exit with 3 before it does anything
//   STUB_RENAMES  how many renames in each process Windows "refuses" first

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const { PassThrough } = require('node:stream');

if (process.env.STUB_MARK) fs.writeFileSync(process.env.STUB_MARK, '');
if (process.env.STUB_CRASH && process.argv[2] === '--refresh') process.exit(3);

let refusals = Number(process.env.STUB_RENAMES) || 0;
const renameSync = fs.renameSync;
fs.renameSync = (...args) => {
  if (refusals-- > 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  return renameSync(...args);
};

https.request = (options, callback) => {
  const { host, path, headers } = options;
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ host, path, authorization: headers.Authorization }) + '\n');
  const { status, body } = JSON.parse(process.env.STUB_REPLY);
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => {
    const res = new PassThrough();
    res.statusCode = status;
    callback(res);
    res.end(JSON.stringify(body));
  };
  return req;
};
