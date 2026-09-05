/**
 * Gallery template system — types + config schema.
 *
 * A gallery template defines a visual layout for displaying images.
 * Photographers pick one template per gallery, then tweak config.
 *
 * v0.2 templates: grid, masonry, lightbox.
 * v0.3+: justified, slideshow, editorial, mosaic.
 */

export type GalleryTemplateId = 'grid' | 'masonry' | 'lightbox';

export type TemplateConfig = {
  gap: number; // pixels between images
  columns: number; // for grid
  aspectRatio: 'preserve' | 'square' | 'landscape' | 'portrait';
  showCaptions: boolean;
  showExif: boolean;
  background: string; // hex color
  textColor: string; // hex color
};

export const defaultConfig: TemplateConfig = {
  gap: 8,
  columns: 3,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
  background: '#0a0a0a',
  textColor: '#fafafa',
};

export const gridConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 8,
  columns: 3,
  aspectRatio: 'landscape',
  showCaptions: false,
  showExif: false,
};

export const masonryConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 12,
  columns: 3,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
};

export const lightboxConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 16,
  columns: 4,
  aspectRatio: 'square',
  showCaptions: false,
  showExif: false,
};

export const templateDefaults: Record<GalleryTemplateId, TemplateConfig> = {
  grid: gridConfig,
  masonry: masonryConfig,
  lightbox: lightboxConfig,
};

export const templateMeta: Record<GalleryTemplateId, { name: string; description: string }> = {
  grid: {
    name: 'Grid',
    description: 'Even grid, consistent aspect ratio. Clean and minimal.',
  },
  masonry: {
    name: 'Masonry',
    description: 'Variable-height tiles, no cropping. Editorial feel.',
  },
  lightbox: {
    name: 'Lightbox-first',
    description: 'Small thumbnails that expand on click. Image-forward.',
  },
};
