import type { Artifact } from '../src/contract';

export function imageCaption(artifact: Artifact, index: number): string {
  const origin = artifact.origin;
  switch (origin.kind) {
    case 'none': return `Image ${index + 1}`;
    case 'url': return origin.url;
    case 'file': return origin.relativePath;
  }
}
