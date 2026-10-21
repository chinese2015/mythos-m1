import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GiteaClient } from '../plugins/mythos-sdlc/gitea.mjs';
const repo = 'demo/demo-nova-catalog-api';
const delivery = { id: 'a'.repeat(64), headBranch: 'mythos/fnd-00009-12345678-' + 'b'.repeat(12), candidateCommit: 'b'.repeat(40), baseBranch: 'main' };
async function fixture(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'mythos-gitea-')), credentialFile = join(dir, 'credentials.json');
  await writeFile(credentialFile, JSON.stringify({ username: 'mythos-agent', password: 'private-fixture-password' }), { mode: 0o600 });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port, client = new GiteaClient({ baseUrl, credentialFile });
  return { baseUrl, client, close: async () => { await client.dispose(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); } };
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const pull = origin => ({ number: 1, html_url: origin + '/' + repo + '/pulls/1', state: 'open', merged: false, user: { login: 'mythos-agent' },
  body: `<!-- mythos-delivery:${delivery.id} -->`, head: { ref: delivery.headBranch, sha: delivery.candidateCommit, repo: { full_name: repo } }, base: { ref: 'main', repo: { full_name: repo } } });
test('lost PR creation acknowledgement is reconciled from all states instead of creating a duplicate', async () => {
  const prs = []; let posts = 0; let f;
  f = await fixture(async (req, res) => {
    assert.match(req.headers.authorization, /^Basic /);
    if (req.method === 'POST') { posts++; for await (const _ of req) {} prs.push(pull(f.baseUrl)); req.socket.destroy(); return; }
    json(res, prs);
  });
  try {
    await assert.rejects(() => f.client.ensurePull(repo, delivery, 'Fix', 'Evidence'), /Gitea/);
    prs[0].state = 'closed';
    const found = await f.client.ensurePull(repo, delivery, 'Fix', 'Evidence');
    assert.equal(found.number, 1); assert.equal(found.state, 'closed'); assert.equal(posts, 1);
    assert.ok(!JSON.stringify(f.client).includes('private-fixture-password'));
  } finally { await f.close(); }
});
test('a colliding branch with another head/marker never authorizes creating a PR', async () => {
  let posts = 0; let f;
  f = await fixture((req, res) => { if (req.method === 'POST') posts++; json(res, [{ ...pull(f.baseUrl), head: { ...pull(f.baseUrl).head, sha: 'c'.repeat(40) } }]); });
  try { await assert.rejects(() => f.client.ensurePull(repo, delivery, 'Fix', 'Evidence'), /不匹配|冲突/); assert.equal(posts, 0); }
  finally { await f.close(); }
});
test('Gitea redirects and unsafe origins are rejected without leaking private response details', async () => {
  const f = await fixture((_req, res) => { res.writeHead(302, { Location: 'http://example.invalid/private-fixture-password' }); res.end(); });
  try {
    await assert.rejects(() => f.client.listPulls(repo), e => !e.message.includes('private-fixture-password'));
    assert.throws(() => new GiteaClient({ baseUrl: 'https://example.com', credentialFile: '/private' }), /loopback/);
    await assert.rejects(() => f.client.listPulls('outside/private'), /仓库/);
  } finally { await f.close(); }
});
test('Gitea null statuses with total_count zero are shown as no CI records', async () => {
  let f;f=await fixture((req,res)=>{
    if(req.url.includes('/git/commits/'))return json(res,{sha:delivery.candidateCommit,commit:{tree:{sha:'e'.repeat(40)}}});
    if(req.url.includes('/reviews'))return json(res,[]);
    if(req.url.includes('/status?'))return json(res,{sha:delivery.candidateCommit,total_count:0,statuses:null});
    return json(res,pull(f.baseUrl));
  });
  try {const facts=await f.client.facts(repo,{...delivery,pullNumber:1});assert.deepEqual(facts.statuses,[]);}
  finally {await f.close();}
});
