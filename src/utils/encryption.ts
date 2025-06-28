import { createCipheriv, createDecipheriv, randomBytes, scrypt, createHash } from 'crypto';
import { promisify } from 'util';
import { logger } from './logger';

const scryptAsync = promisify(scrypt);

interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
  algorithm: string;
  keyDerivation: {
    salt: string;
    iterations: number;
    keyLength: number;
  };
}

export class EncryptionService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly SALT_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly ITERATIONS = 100000;
  
  private static masterKey: Buffer | null = null;
  
  /**
   * Initialize the encryption service with a master key
   */
  static async initialize(masterSecret: string): Promise<void> {
    if (!masterSecret || masterSecret.length < 32) {
      throw new Error('Master secret must be at least 32 characters');
    }
    
    // Derive master key from secret
    const salt = Buffer.from(process.env.ENCRYPTION_SALT || 'default-salt-change-in-production', 'utf8');
    this.masterKey = (await scryptAsync(masterSecret, salt, this.KEY_LENGTH)) as Buffer;
    
    logger.info('Encryption service initialized');
  }
  
  /**
   * Encrypt sensitive data with authenticated encryption
   */
  static async encrypt(plaintext: string, context?: string): Promise<EncryptedData> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }
    
    try {
      // Generate random salt and IV
      const salt = randomBytes(this.SALT_LENGTH);
      const iv = randomBytes(this.IV_LENGTH);
      
      // Derive encryption key from master key and salt
      const key = await this.deriveKey(this.masterKey, salt, context);
      
      // Create cipher
      const cipher = createCipheriv(this.ALGORITHM, key, iv);
      
      // Add additional authenticated data if context provided
      if (context) {
        cipher.setAAD(Buffer.from(context, 'utf8'));
      }
      
      // Encrypt data
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);
      
      // Get authentication tag
      const tag = cipher.getAuthTag();
      
      return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        algorithm: this.ALGORITHM,
        keyDerivation: {
          salt: salt.toString('base64'),
          iterations: this.ITERATIONS,
          keyLength: this.KEY_LENGTH
        }
      };
    } catch (error) {
      logger.error('Encryption failed', { error: error as Error });
      throw new Error('Failed to encrypt data');
    }
  }
  
  /**
   * Decrypt data with authentication verification
   */
  static async decrypt(encryptedData: EncryptedData, context?: string): Promise<string> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }
    
    try {
      // Decode from base64
      const encrypted = Buffer.from(encryptedData.encrypted, 'base64');
      const iv = Buffer.from(encryptedData.iv, 'base64');
      const tag = Buffer.from(encryptedData.tag, 'base64');
      const salt = Buffer.from(encryptedData.keyDerivation.salt, 'base64');
      
      // Derive decryption key
      const key = await this.deriveKey(this.masterKey, salt, context);
      
      // Create decipher
      const decipher = createDecipheriv(encryptedData.algorithm, key, iv);
      decipher.setAuthTag(tag);
      
      // Add additional authenticated data if context provided
      if (context) {
        decipher.setAAD(Buffer.from(context, 'utf8'));
      }
      
      // Decrypt data
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      
      return decrypted.toString('utf8');
    } catch (error) {
      logger.error('Decryption failed', { error: error as Error });
      throw new Error('Failed to decrypt data or authentication failed');
    }
  }
  
  /**
   * Derive a key from master key and salt with optional context
   */
  private static async deriveKey(masterKey: Buffer, salt: Buffer, context?: string): Promise<Buffer> {
    let keyMaterial = masterKey;
    
    // Add context to key derivation if provided
    if (context) {
      const contextHash = createHash('sha256').update(context).digest();
      keyMaterial = Buffer.concat([masterKey, contextHash]);
    }
    
    return (await scryptAsync(keyMaterial, salt, this.KEY_LENGTH)) as Buffer;
  }
  
  /**
   * Encrypt specific fields in an object
   */
  static async encryptFields<T extends Record<string, any>>(
    obj: T,
    fieldsToEncrypt: (keyof T)[],
    context?: string
  ): Promise<T> {
    const result = { ...obj };
    
    for (const field of fieldsToEncrypt) {
      if (result[field] !== undefined && result[field] !== null) {
        const encrypted = await this.encrypt(String(result[field]), context);
        (result as any)[`${String(field)}_encrypted`] = encrypted;
        delete result[field];
      }
    }
    
    return result;
  }
  
  /**
   * Decrypt specific fields in an object
   */
  static async decryptFields<T extends Record<string, any>>(
    obj: T,
    fieldsToDecrypt: string[],
    context?: string
  ): Promise<T> {
    const result = { ...obj };
    
    for (const field of fieldsToDecrypt) {
      const encryptedField = `${field}_encrypted`;
      if (result[encryptedField]) {
        try {
          result[field] = await this.decrypt(result[encryptedField], context);
          delete result[encryptedField];
        } catch (error) {
          logger.error(`Failed to decrypt field ${field}`, { error: error as Error });
        }
      }
    }
    
    return result;
  }
  
  /**
   * Generate a cryptographically secure token
   */
  static generateSecureToken(length: number = 32): string {
    return randomBytes(length).toString('base64url');
  }
  
  /**
   * Hash sensitive data for comparison (e.g., API keys)
   */
  static hashData(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Anonymize PII data while maintaining consistency
   */
  static anonymizePII(data: string, salt: string = 'default'): string {
    const hash = createHash('sha256')
      .update(data + salt)
      .digest('hex');
    
    // Return first 8 chars for readability while maintaining uniqueness
    return `anon_${hash.substring(0, 8)}`;
  }
}

// Field-level encryption helpers for database operations
export class FieldEncryption {
  private static readonly SENSITIVE_FIELDS = [
    'email',
    'phone',
    'ssn',
    'credit_card',
    'api_key',
    'token',
    'password'
  ];
  
  /**
   * Check if a field should be encrypted based on its name
   */
  static shouldEncryptField(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    return this.SENSITIVE_FIELDS.some(sensitive => lowerField.includes(sensitive));
  }
  
  /**
   * Encrypt sensitive fields in a database record
   */
  static async encryptRecord<T extends Record<string, any>>(
    record: T,
    additionalFields?: string[]
  ): Promise<T> {
    const fieldsToEncrypt: string[] = [];
    
    // Auto-detect sensitive fields
    for (const key of Object.keys(record)) {
      if (this.shouldEncryptField(key)) {
        fieldsToEncrypt.push(key);
      }
    }
    
    // Add any additional specified fields
    if (additionalFields) {
      fieldsToEncrypt.push(...additionalFields);
    }
    
    if (fieldsToEncrypt.length === 0) {
      return record;
    }
    
    return EncryptionService.encryptFields(
      record,
      fieldsToEncrypt,
      `record:${record.id || 'unknown'}`
    );
  }
  
  /**
   * Decrypt sensitive fields in a database record
   */
  static async decryptRecord<T extends Record<string, any>>(
    record: T
  ): Promise<T> {
    const encryptedFields = Object.keys(record).filter(key => key.endsWith('_encrypted'));
    const fieldsToDecrypt = encryptedFields.map(field => field.replace('_encrypted', ''));
    
    if (fieldsToDecrypt.length === 0) {
      return record;
    }
    
    return EncryptionService.decryptFields(
      record,
      fieldsToDecrypt,
      `record:${record.id || 'unknown'}`
    );
  }
}

// Export a singleton instance
export const encryption = EncryptionService;
export const fieldEncryption = FieldEncryption;