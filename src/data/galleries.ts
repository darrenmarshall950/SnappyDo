/**
 * Sample gallery data — placeholder until Supabase is wired in v0.3.
 * Each gallery has: id, slug, title, description, cover_image, images[].
 *
 * Image source: picsum.photos (real photos, random seed for stable demo).
 * EXIF data is mocked — real extraction via exifr in v0.3.
 */
export type GalleryImage = {
  id: string;
  src: string;
  thumb: string;
  width: number;
  height: number;
  alt: string;
  exif: {
    camera: string;
    lens: string;
    iso: number;
    aperture: string;
    shutter: string;
    focalLength: string;
    takenAt: string;
  };
};

export type Gallery = {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  passwordProtected: boolean;
  images: GalleryImage[];
};

function img(seed: string, w = 2000, h = 1333): GalleryImage {
  return {
    id: seed,
    src: `https://picsum.photos/seed/${seed}/${w}/${h}`,
    thumb: `https://picsum.photos/seed/${seed}/600/${Math.round((600 * h) / w)}`,
    width: w,
    height: h,
    alt: `Sample photograph ${seed}`,
    exif: {
      camera: pick(seed, 'Sony A7 IV', 'Canon R5', 'Nikon Z9', 'Leica Q3'),
      lens: pick(seed, '24-70mm f/2.8', '35mm f/1.4', '85mm f/1.4', '70-200mm f/2.8'),
      iso: pick(seed, 100, 200, 400, 800, 1600),
      aperture: pick(seed, 'f/1.8', 'f/2.8', 'f/4.0', 'f/5.6', 'f/8.0'),
      shutter: pick(seed, '1/2000', '1/500', '1/250', '1/125', '1/60'),
      focalLength: pick(seed, '35mm', '50mm', '85mm', '135mm', '200mm'),
      takenAt: '2026-08-' + (10 + (hash(seed) % 20)).toString().padStart(2, '0') + 'T14:30:00Z',
    },
  };
}

function pick<T>(seed: string, ...opts: T[]): T {
  return opts[hash(seed) % opts.length]!;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const galleries: Gallery[] = [
  {
    id: 'g1',
    slug: 'iceland-winter',
    title: 'Iceland — Winter Light',
    description: 'Eight days chasing aurora and winter storms around the Ring Road.',
    coverImage: 'https://picsum.photos/seed/iceland-cover/2000/1200',
    passwordProtected: false,
    images: [
      img('iceland-1', 2000, 1333),
      img('iceland-2', 2000, 1333),
      img('iceland-3', 1333, 2000),
      img('iceland-4', 2000, 1333),
      img('iceland-5', 2000, 1333),
      img('iceland-6', 1333, 2000),
      img('iceland-7', 2000, 1333),
      img('iceland-8', 2000, 1333),
      img('iceland-9', 2000, 1333),
      img('iceland-10', 1333, 2000),
      img('iceland-11', 2000, 1333),
      img('iceland-12', 2000, 1333),
    ],
  },
  {
    id: 'g2',
    slug: 'tokyo-nights',
    title: 'Tokyo Nights',
    description: 'Neon, rain, and long exposures in Shibuya and Shinjuku.',
    coverImage: 'https://picsum.photos/seed/tokyo-cover/2000/1200',
    passwordProtected: false,
    images: [
      img('tokyo-1', 1333, 2000),
      img('tokyo-2', 2000, 1333),
      img('tokyo-3', 2000, 1333),
      img('tokyo-4', 1333, 2000),
      img('tokyo-5', 2000, 1333),
      img('tokyo-6', 2000, 1333),
      img('tokyo-7', 1333, 2000),
      img('tokyo-8', 2000, 1333),
    ],
  },
  {
    id: 'g3',
    slug: 'studio-portraits',
    title: 'Studio Portraits',
    description: 'Available-light portraits, mostly prime lenses.',
    coverImage: 'https://picsum.photos/seed/studio-cover/2000/1200',
    passwordProtected: true,
    images: [
      img('studio-1', 1333, 2000),
      img('studio-2', 1333, 2000),
      img('studio-3', 1333, 2000),
      img('studio-4', 1333, 2000),
      img('studio-5', 1333, 2000),
      img('studio-6', 1333, 2000),
    ],
  },
];

export function getGalleryBySlug(slug: string): Gallery | undefined {
  return galleries.find((g) => g.slug === slug);
}
