import path from 'path';
import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

const blockedExtensions = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar',
  '.msi', '.sh', '.php', '.php3', '.php4', '.phtml', '.phps', '.html', '.htm',
  '.svg', '.jsp', '.asp', '.aspx', '.cgi', '.pl'
]);

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/octet-stream',
  'binary/octet-stream',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/m4a',
  'audio/mp4',
  'audio/aac'
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const originalName = String(file.originalname || '');
    if (originalName.includes('\0') || originalName.includes('%00')) {
      return callback(new ApiError(400, 'Invalid filename signature detected'));
    }
    const ext = path.extname(originalName).toLowerCase();
    if (blockedExtensions.has(ext) || Boolean(originalName.toLowerCase().match(/\.(php|exe|sh|jsp|asp|bat)\./))) {
      return callback(new ApiError(400, 'File extension is blocked by security policy'));
    }
    const normalizedMime = (file.mimetype || '').toLowerCase();
    const isDocOrPdf = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv'].includes(ext);
    if (!allowedMimeTypes.has(normalizedMime) && !(normalizedMime === 'application/octet-stream' && isDocOrPdf)) {
      return callback(new ApiError(400, 'Unsupported file type'));
    }
    callback(null, true);
  }
});
