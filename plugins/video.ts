import type { Processor, ProcessorRegistration } from '../src/contract';
const bytes = (text: string) => new Blob([text]).stream();
export const videoRegistration: ProcessorRegistration = { id: 'video-viewer', version: '0.1.0', accepts: ['video/*'], grants: ['transcribe'] };
export const createVideoProcessor = (component: string): Processor => ({
  async process(input, host) {
    if (input.originals.length !== 1 || !input.originals[0].mediaType.startsWith('video/')) throw new Error('Video viewer requires exactly one supported original');
    const original = input.originals[0];
    const segments = await host.transcribe(original.id);
    const transcript = await host.write({ role: 'transcript', mediaType: 'application/json' }, bytes(JSON.stringify({ segments })));
    const text = segments.map(segment => segment.text).join('\n');
    const fallback = await host.write({ role: 'transcript-text', mediaType: 'text/plain' }, bytes(text));
    const thumbnail = await host.write({ role: 'thumbnail', mediaType: 'image/svg+xml' }, bytes('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#12385c"/><rect x="125" y="55" width="70" height="70" fill="#4bc7ff"/><text x="12" y="160" fill="white" font-size="14">Synthetic video fixture</text></svg>'));
    // Transcript structure belongs to this processor and its viewer, not the host contract.
    const source = component.replace('__MAGPIE_TRANSCRIPT_ARTIFACT__', JSON.stringify(transcript.id).replaceAll('<', '\\u003c'));
    const view = await host.write({ role: 'component', mediaType: 'text/html' }, bytes(source));
    return [{ title: 'Synthetic video: blue and green', description: 'Controlled transcript fixture; no real transcription provider.', artifacts: [transcript.id, fallback.id, thumbnail.id, view.id, original.id], search: segments.map(segment => ({ text: segment.text, artifact: original.id })), presentation: { fallback: fallback.id, thumbnail: thumbnail.id, component: view.id } }];
  },
});
