/**
 * Gallery template system — types + config schema.
 *
 * A gallery template defines a visual layout for displaying images.
 * Photographers pick one template per gallery, then tweak config.
 *
 * v0.2: grid, masonry, lightbox.
 * v0.3: + cover, carousel, slideshow, justified.
 */

export type GalleryTemplateId =
  | 'grid'
  | 'masonry'
  | 'lightbox'
  | 'cover'
  | 'carousel'
  | 'slideshow'
  | 'justified'
  | 'mosaic'
  | 'cinema'
  | 'framed'
  | 'contact-sheet';

export type FrameStyle = 'none' | 'matte' | 'gallery' | 'polaroid';

export const VALID_FRAMES: FrameStyle[] = ['none', 'matte', 'gallery', 'polaroid'];

export type TemplateConfig = {
  gap: number; // pixels between images
  columns: number; // for grid / justified / masonry
  aspectRatio: 'preserve' | 'square' | 'landscape' | 'portrait';
  showCaptions: boolean;
  showExif: boolean;
  background: string;
  textColor: string;
  /** Hero position for cover template: 0..n */
  coverIndex?: number;
  /** Slideshow template: auto-advance in ms (0 = off) */
  autoAdvanceMs?: number;
  /** Slideshow template: ken-burns zoom */
  kenBurns?: boolean;
  /** Watermark applied to the lightbox hero (proves ownership, deters download-claim). */
  watermark?: {
    text: string; // e.g. photographer name, copyright line
    opacity?: number; // 0..100
    position?: 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest' | 'center';
    scale?: number; // 0..100, default ~15
  } | null;
  /** Subtle decorative border around each image. Applied per-template. */
  frame?: FrameStyle;
};

export const defaultConfig: TemplateConfig = {
  gap: 8,
  columns: 3,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
  background: '#0a0a0a',
  textColor: '#fafafa',
  autoAdvanceMs: 0,
  kenBurns: false,
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

export const coverConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 0,
  columns: 1,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: true,
  coverIndex: 0,
};

export const carouselConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 0,
  columns: 1,
  aspectRatio: 'landscape',
  showCaptions: true,
  showExif: false,
};

export const slideshowConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 0,
  columns: 1,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
  autoAdvanceMs: 5000,
  kenBurns: true,
};

export const justifiedConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 4,
  columns: 4,
  aspectRatio: 'preserve',
  showCaptions: false,
  showExif: false,
};

export const mosaicConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 8,
  columns: 4,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
};

export const cinemaConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 0,
  columns: 1,
  aspectRatio: 'preserve',
  showCaptions: false,
  showExif: true,
  autoAdvanceMs: 6500,
  kenBurns: false,
};

export const framedConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 32,
  columns: 2,
  aspectRatio: 'preserve',
  showCaptions: true,
  showExif: false,
  frame: 'matte',
};

export const contactSheetConfig: TemplateConfig = {
  ...defaultConfig,
  gap: 0,
  columns: 5,
  aspectRatio: 'landscape',
  showCaptions: false,
  showExif: false,
};

export const templateDefaults: Record<GalleryTemplateId, TemplateConfig> = {
  grid: gridConfig,
  masonry: masonryConfig,
  lightbox: lightboxConfig,
  cover: coverConfig,
  carousel: carouselConfig,
  slideshow: slideshowConfig,
  justified: justifiedConfig,
  mosaic: mosaicConfig,
  cinema: cinemaConfig,
  framed: framedConfig,
  'contact-sheet': contactSheetConfig,
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
    name: 'Lightbox',
    description: 'Small thumbnails that expand on click. Image-forward.',
  },
  cover: {
    name: 'Cover',
    description: 'Cinematic hero image with title. Click to enter gallery.',
  },
  carousel: {
    name: 'Carousel',
    description: 'Single-image showcase with prev/next. Editorial pacing.',
  },
  slideshow: {
    name: 'Slideshow',
    description: 'Full-bleed auto-advance with captions. Set the mood.',
  },
  justified: {
    name: 'Justified',
    description: 'Variable-height rows justified to a fixed width. Flickr/500px style.',
  },
  mosaic: {
    name: 'Mosaic',
    description: 'Magazine-style mixed-size grid with hero-led rhythm.',
  },
  cinema: {
    name: 'Cinema',
    description: 'Letterboxed 21:9 widescreen, slow fades. Cinematic pace.',
  },
  framed: {
    name: 'Framed',
    description: 'Each photo in a subtle matte or gallery frame. Museum-print feel.',
  },
  'contact-sheet': {
    name: 'Contact sheet',
    description: 'Vintage 35mm contact print on a photographer light box. Film strips with sprocket holes.',
  },
};

export const VALID_TEMPLATES: GalleryTemplateId[] = [
  'grid',
  'masonry',
  'lightbox',
  'cover',
  'carousel',
  'slideshow',
  'justified',
  'mosaic',
  'cinema',
  'framed',
  'contact-sheet',
];
