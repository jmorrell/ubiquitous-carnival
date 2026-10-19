import type { Process, ProcessorRegistration, Publication } from '../src/contract';
import { imageCaption } from './image-caption';

export const photoItemsRegistration: ProcessorRegistration = { id: 'photo-items', version: '0.1.0', accepts: ['image/*'] };
/** The same image batch can produce separate items instead of one gallery. */
export const processPhotos: Process = async (input, { write }) => {
  if (!input.originals.length || input.originals.some(original => !original.mediaType.startsWith('image/'))) throw new Error('Photo items require image originals');
  // Deliberately shared metadata, without granting the other photos or their descriptors.
  const index = await write({ role: 'photo-index', mediaType: 'application/json' }, new Blob([JSON.stringify({ title: 'Imported images', count: input.originals.length })]).stream());
  const publications: Publication[] = [];
  for (const [position, original] of input.originals.entries()) {
    const caption = imageCaption(original, position);
    const fallback = await write({ role: 'photo-caption', mediaType: 'text/plain' }, new Blob([caption]).stream());
    publications.push({
      title: caption, description: 'One image from the submitted batch.',
      artifacts: [original.id, fallback.id, index.id],
      search: [{ text: caption, artifact: original.id }],
      presentation: { fallback: fallback.id },
    });
  }
  return publications;
};
