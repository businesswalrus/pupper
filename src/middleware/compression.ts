import { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';
import { Transform, pipeline } from 'stream';
import { logger } from '@utils/logger';

export interface CompressionOptions {
  threshold?: number;           // Min bytes before compression (default: 1024)
  level?: number;              // Compression level 0-9 (default: 6)
  memLevel?: number;           // Memory level 1-9 (default: 8)
  filter?: (req: Request, res: Response) => boolean;
  encodings?: string[];        // Supported encodings (default: ['gzip', 'deflate', 'br'])
}

const DEFAULT_OPTIONS: CompressionOptions = {
  threshold: 1024,             // 1KB minimum
  level: 6,
  memLevel: 8,
  encodings: ['br', 'gzip', 'deflate'],
};

/**
 * High-performance compression middleware with Brotli support
 */
export function createCompressionMiddleware(options: CompressionOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip if already compressed
    if (res.headersSent || res.locals.compressed) {
      return next();
    }

    // Check filter function
    if (opts.filter && !opts.filter(req, res)) {
      return next();
    }

    // Get accepted encodings
    const acceptedEncodings = getAcceptedEncodings(req, opts.encodings!);
    if (!acceptedEncodings.length) {
      return next();
    }

    // Choose best encoding
    const encoding = acceptedEncodings[0];

    // Store original methods
    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalOn = res.on;

    let stream: Transform | null = null;
    let dataLength = 0;
    const chunks: Buffer[] = [];
    let isCompressing = false;

    // Override write method
    res.write = function(chunk: any, ...args: any[]): boolean {
      if (!chunk || res.headersSent) {
        return originalWrite.apply(res, [chunk, ...args] as any);
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      dataLength += buffer.length;
      chunks.push(buffer);

      // Start compression if threshold reached
      if (!isCompressing && dataLength >= opts.threshold!) {
        startCompression();
      }

      return true;
    };

    // Override end method
    res.end = function(chunk?: any, ...args: any[]): any {
      if (chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        dataLength += buffer.length;
        chunks.push(buffer);
      }

      // Decide whether to compress
      if (!isCompressing && dataLength >= opts.threshold!) {
        startCompression();
      } else if (!isCompressing) {
        // Send uncompressed
        restoreOriginalMethods();
        if (chunks.length) {
          originalWrite.call(res, Buffer.concat(chunks));
        }
        return originalEnd.apply(res, args as any);
      }

      // Finish compression
      if (stream) {
        const allData = Buffer.concat(chunks);
        stream.end(allData);
      } else {
        return originalEnd.apply(res, [chunk, ...args] as any);
      }
    };

    // Override on method to intercept 'drain' events
    res.on = function(event: string, listener: any): any {
      if (event === 'drain' && stream) {
        return stream.on('drain', listener);
      }
      return originalOn.call(res, event, listener);
    };

    function startCompression() {
      isCompressing = true;
      res.locals.compressed = true;

      // Set headers
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      res.setHeader('Vary', 'Accept-Encoding');

      // Create compression stream
      stream = createCompressionStream(encoding, opts);

      // Pipe to response
      stream.pipe(res as any);

      // Handle errors
      stream.on('error', (err) => {
        logger.error('Compression stream error', { error: err, encoding });
        restoreOriginalMethods();
        next(err);
      });
    }

    function restoreOriginalMethods() {
      res.write = originalWrite;
      res.end = originalEnd;
      res.on = originalOn;
    }

    next();
  };
}

/**
 * Create compression stream based on encoding
 */
function createCompressionStream(encoding: string, options: CompressionOptions): Transform {
  const zlibOptions = {
    level: options.level,
    memLevel: options.memLevel,
  };

  switch (encoding) {
    case 'br':
      return zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: options.level!,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: options.threshold!,
        },
      });

    case 'gzip':
      return zlib.createGzip(zlibOptions);

    case 'deflate':
      return zlib.createDeflate(zlibOptions);

    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }
}

/**
 * Get accepted encodings from request
 */
function getAcceptedEncodings(req: Request, supportedEncodings: string[]): string[] {
  const acceptEncoding = req.headers['accept-encoding'];
  if (!acceptEncoding) return [];

  const accepted = acceptEncoding
    .toString()
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(e => supportedEncodings.includes(e));

  // Prefer Brotli > Gzip > Deflate
  return accepted.sort((a, b) => {
    const priority: Record<string, number> = { br: 3, gzip: 2, deflate: 1 };
    return (priority[b] || 0) - (priority[a] || 0);
  });
}

/**
 * Request decompression middleware
 */
export function createDecompressionMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const encoding = req.headers['content-encoding'];
    if (!encoding) return next();

    let stream: Transform;

    switch (encoding) {
      case 'br':
        stream = zlib.createBrotliDecompress();
        break;
      case 'gzip':
        stream = zlib.createGunzip();
        break;
      case 'deflate':
        stream = zlib.createInflate();
        break;
      default:
        return next();
    }

    // Replace request stream
    const originalPipe = req.pipe;
    req.pipe = function(destination: any, options?: any) {
      return originalPipe.call(req, stream).pipe(destination, options);
    };

    // Handle decompression errors
    stream.on('error', (err) => {
      logger.error('Decompression error', { error: err, encoding });
      res.status(400).json({ error: 'Invalid compressed data' });
    });

    // Update content-length after decompression
    let data = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
    });

    stream.on('end', () => {
      req.headers['content-length'] = data.length.toString();
      delete req.headers['content-encoding'];
    });

    next();
  };
}

/**
 * Compression filter for specific content types
 */
export function shouldCompress(req: Request, res: Response): boolean {
  // Don't compress if already compressed
  if (res.getHeader('Content-Encoding')) {
    return false;
  }

  // Check content type
  const contentType = res.getHeader('Content-Type');
  if (!contentType) return true;

  const compressibleTypes = [
    'text/',
    'application/json',
    'application/javascript',
    'application/xml',
    'application/rss+xml',
    'application/atom+xml',
    'application/xhtml+xml',
    'application/x-font-ttf',
    'image/svg+xml',
  ];

  const type = contentType.toString().toLowerCase();
  return compressibleTypes.some(t => type.includes(t));
}

/**
 * Streaming compression for large responses
 */
export class StreamingCompressor {
  private readonly encoding: string;
  private readonly stream: Transform;

  constructor(encoding: string = 'gzip', options: CompressionOptions = {}) {
    this.encoding = encoding;
    this.stream = createCompressionStream(encoding, options);
  }

  compress(data: Buffer | string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      this.stream.on('data', (chunk) => chunks.push(chunk));
      this.stream.on('end', () => resolve(Buffer.concat(chunks)));
      this.stream.on('error', reject);

      this.stream.end(data);
    });
  }

  pipe(destination: NodeJS.WritableStream): Transform {
    return this.stream.pipe(destination);
  }
}

// Export pre-configured middleware
export const compression = createCompressionMiddleware({
  threshold: 1024,
  level: 6,
  filter: shouldCompress,
});

export const decompression = createDecompressionMiddleware();