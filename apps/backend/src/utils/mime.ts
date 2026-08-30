import { Buffer } from 'buffer';

/**
 * Content type by magic bytes, with the caller's hint only as a fallback.
 *
 * Extracted from index.ts so the Meta media route can use the same one rather
 * than growing a second opinion about what a file is. The behaviour is
 * unchanged.
 *
 * Sniffing rather than trusting is the point. OpenWA reports the wrong MIME for
 * voice notes often enough that the media proxy stopped believing it, and Meta's
 * mime_type is attacker-influenced in the sense that matters here: it arrives
 * with content the customer chose. Echoing a supplied content type is how an
 * uploaded file gets served as script.
 */
export function detectMimeType(buf: Buffer, mediaType?: string): string {
  const sig = buf.slice(0, 8).toString('hex');
  // OGG / Opus — WhatsApp voice notes (ptt)
  if (sig.startsWith('4f676753')) return 'audio/ogg; codecs=opus';
  // MP3
  if (buf.slice(0, 3).toString('ascii') === 'ID3' || sig.startsWith('fffb') || sig.startsWith('fff3')) return 'audio/mpeg';
  // JPEG
  if (sig.startsWith('ffd8ff')) return 'image/jpeg';
  // PNG
  if (sig.startsWith('89504e47')) return 'image/png';
  // GIF
  if (sig.startsWith('47494638')) return 'image/gif';
  // WebP (RIFF....WEBP)
  if (sig.startsWith('52494646') && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // MP4
  if (sig.slice(8, 16) === '66747970') return 'video/mp4';
  // WebM
  if (sig.startsWith('1a45dfa3')) return 'video/webm';
  // PDF
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  // Fallback to mediaType hint if available
  const hint: Record<string, string> = {
    ptt: 'audio/ogg; codecs=opus', audio: 'audio/mpeg',
    image: 'image/jpeg', video: 'video/mp4',
    document: 'application/octet-stream', sticker: 'image/webp',
  };
  return hint[mediaType || ''] || 'application/octet-stream';
}

