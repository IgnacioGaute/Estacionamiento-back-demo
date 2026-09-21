import { FileValidator } from '@nestjs/common';

// Only inspect fixed image signatures. Do not parse arbitrary archive/document
// formats supplied by an untrusted upload just to determine its file type.
export class ImageSignatureValidator extends FileValidator<Record<string, never>> {
  constructor() { super({}); }

  isValid(file?: Express.Multer.File): boolean {
    const b = file?.buffer;
    if (!b || b.length < 12) return false;
    if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (file.mimetype === 'image/png') return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return file.mimetype === 'image/webp' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  }

  buildErrorMessage(): string { return 'Subí una imagen JPEG, PNG o WebP.'; }
}
