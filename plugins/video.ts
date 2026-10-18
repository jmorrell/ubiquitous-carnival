import type { Processor, ProcessorRegistration, TargetDraft } from '../src/contract';
const bytes = (text: string) => new Blob([text]).stream();
export const videoRegistration: ProcessorRegistration = { id: 'video-notes', version: '0.1.0', accepts: ['video/*'], grants: ['transcribe'] };
export const createVideoProcessor = (component: string, profile: 'v1' | 'v2' = 'v1'): Processor => ({
  async process(input, host) {
    const original = input.originals[0];
    const segments = await host.transcribe(original.id, profile);
    const transcript = await host.write({ role: 'transcript', mediaType: 'application/json' }, bytes(JSON.stringify({ segments })));
    const text = segments.map(segment => segment.text).join('\n');
    const fallback = await host.write({ role: 'transcript-text', mediaType: 'text/plain' }, bytes(text));
    const thumbnail = await host.write({ role: 'thumbnail', mediaType: 'image/svg+xml' }, bytes('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#12385c"/><rect x="125" y="55" width="70" height="70" fill="#4bc7ff"/><text x="12" y="160" fill="white" font-size="14">Synthetic video fixture</text></svg>'));
    const view = await host.write({ role: 'component', mediaType: 'text/html' }, bytes(component));
    const targets: TargetDraft[] = []; let offset = 0;
    segments.forEach((segment, i) => {
      targets.push({ key: `cue-${i}`, artifact: original.id, selector: { kind: 'time', startMs: segment.startMs, endMs: segment.endMs } });
      targets.push({ key: `text-${i}`, artifact: fallback.id, selector: { kind: 'text', start: offset, end: offset + segment.text.length, quote: segment.text } });
      offset += segment.text.length + 1;
    });
    return { title: 'Synthetic video: blue and green', description: 'Controlled transcript fixture; no real transcription provider.', artifacts: [transcript.id, fallback.id, thumbnail.id, view.id], targets, search: segments.map((segment, i) => ({ text: segment.text, target: `cue-${i}` })), presentation: { fallback: fallback.id, thumbnail: thumbnail.id, component: view.id } };
  },
});
