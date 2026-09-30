import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const extract = name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const workers = [];
class TestWorker {
  constructor() { workers.push(this); this.requests = []; }
  postMessage(task, transfer) {
    this.requests.push(structuredClone(task, {transfer}));
    assert.equal(task.data.byteLength, 0, 'RGBA ownership transfers to the worker');
  }
  terminate() { this.terminated = true; }
  complete(bytes = [71, 73, 70]) {
    const task = this.requests.at(-1);
    this.onmessage({data:{index:task.index, data:[new Uint8Array([...bytes, 0, 0])], cursor:bytes.length, globalPalette:[0, 0, 0]}});
  }
}
const ctx = vm.createContext({Worker:TestWorker, Blob, setTimeout, clearTimeout, throwIfExportCancelled:()=>{}});
vm.runInContext(extract('createStreamingGifEncoder'), ctx);
const options = {width:2, height:2, quality:1, dither:false, globalPalette:[0,0,0], workerScript:'gif.worker.js'};
const canvas = {getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray(16)})})};
const encoder = ctx.createStreamingGifEncoder(options, 337);
const worker = workers.at(-1);
for (let index = 0; index < 337; index++) {
  let settled = false;
  const encoding = encoder.addFrame(canvas, {delay:500}).then(()=>{settled=true;});
  await Promise.resolve();
  assert.equal(settled, false, 'Compositing waits for the current frame to finish encoding');
  assert.equal(worker.requests.length, index + 1);
  assert.equal(worker.requests.at(-1).index, index);
  assert.equal(worker.requests.at(-1).last, index === 336);
  assert.equal(worker.requests.at(-1).delay, 500);
  await assert.rejects(encoder.addFrame(canvas, {delay:500}), /not ready/);
  worker.complete([index % 256]);
  await encoding;
  // The test harness must not retain transferred pixel buffers either.
  delete worker.requests.at(-1).data;
}
const blob = encoder.finish();
assert.equal(blob.type, 'image/gif');
assert.equal(blob.size, 337, 'Do not append worker page padding');
assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], Array.from({length:337}, (_,i)=>i%256));
encoder.dispose();
assert.ok(worker.terminated);
assert.equal(blob.size, 337, 'Disposing the worker preserves the downloadable Blob');

for (const failure of ['cancel', 'worker-error', 'message-error']) {
  const attempt = ctx.createStreamingGifEncoder(options, 2);
  const instance = workers.at(-1);
  const encoding = attempt.addFrame(canvas, {delay:1000});
  if (failure === 'cancel') attempt.abort();
  if (failure === 'worker-error') instance.onerror({preventDefault(){}});
  if (failure === 'message-error') instance.onmessageerror();
  await assert.rejects(encoding, /aborted|failed|Could not read/);
  assert.ok(instance.terminated);
  assert.throws(()=>attempt.finish(), /incomplete/);
  await assert.rejects(attempt.addFrame(canvas, {delay:1000}), /not ready/);
}

// Release every capture on both a failed composite and the affine-map fallback.
for (const fallback of [false, true]) {
  const captures = Array.from({length:5},()=>({width:100,height:200,getContext:()=>({drawImage(){}})}));
  const composite = vm.createContext({
    document:{createElement:()=>captures[4]},
    captureFastGifBaseCanvas:async()=>({baseCanvas:captures[0],mapForegroundCanvas:captures[1],roadLabelsCanvas:captures[2],chromeCanvas:captures[3],overlayRect:fallback?null:{x:0,y:0,width:100,height:200}}),
    throwIfExportCancelled(){}, setDownloadStatus(){}, setExportProgress(){},
    EXPORT_PROGRESS_UPDATE_EVERY:8, overlayOpacity:0.75,
    getExportFrameImage:async()=>{throw Error('image failed');},
    withExportFrames:async()=>{},
  });
  vm.runInContext(extract('addFastCompositeGifFrames'), composite);
  const result = composite.addFastCompositeGifFrames({}, [{entry:{}}]);
  if (fallback) await result;
  else await assert.rejects(result, /image failed/);
  assert.ok(captures.every(c=>c.width===1&&c.height===1), 'Release all large canvases on every exit');
}

// Adjacent water levels and distinct physics frames must resolve independently.
const requested = [];
const images = vm.createContext({
  currentOverlayMode:'depth', getStageValue:e=>e.stage, getOverlayStage:()=>3.3,
  getHydraulicPhaseForEntry:()=> 'filling', getPhysicsAssetForEntry:e=>e.physics,
  getPhysicsDisplayRecord:a=>a, throwIfExportCancelled(){},
  getHydraulicOverlayRecord:async(mode,stage,phase,entry)=>({url:`stage-${entry.stage}`}),
  getExportImageElement:async url=>{requested.push(url);return{src:url};},
});
vm.runInContext(extract('getExportFrameImage'), images);
await images.getExportFrameImage({entry:{stage:3.31}});
await images.getExportFrameImage({entry:{stage:3.39}});
await images.getExportFrameImage({entry:{stage:3.31,physics:{url:'physics-specific-frame'}}});
assert.deepEqual(requested, ['stage-3.31','stage-3.39','physics-specific-frame']);
console.log('PASS bounded GIF encoding: 337 frames, transferred buffers, order, page lengths, cancellation/failure, canvas cleanup and raster identity.');
