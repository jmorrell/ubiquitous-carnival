import type { ArtifactId, Process, ProcessorRegistration } from '../src/contract';
import { imageCaption } from './image-caption';

/** A deliberately small collection example; the host does not interpret this manifest. */
export interface GalleryManifest {
  images: { artifact: ArtifactId; caption: string }[];
}
export const galleryRegistration: ProcessorRegistration = { id: 'image-gallery', version: '0.1.0', accepts: ['image/*'] };
export const processGallery: Process = async (input, { write }) => {
  if (!input.originals.length || input.originals.some(original => !original.mediaType.startsWith('image/'))) throw new Error('Gallery requires image originals');
  const manifest: GalleryManifest = { images: input.originals.map((original, index) => ({
    artifact: original.id,
    caption: imageCaption(original, index),
  })) };
  const gallery = await write({ role: 'gallery-manifest', mediaType: 'application/json' }, new Blob([JSON.stringify(manifest)]).stream());
  const fallback = await write({ role: 'gallery-list', mediaType: 'text/plain' }, new Blob([manifest.images.map(image => image.caption).join('\n')]).stream());
  return [{
    title: 'Image gallery', description: `${manifest.images.length} original images in input order.`,
    artifacts: [gallery.id, fallback.id, ...input.originals.map(original => original.id)],
    search: manifest.images.map(image => ({ text: image.caption, artifact: image.artifact })),
    presentation: { fallback: fallback.id },
  }];
};
