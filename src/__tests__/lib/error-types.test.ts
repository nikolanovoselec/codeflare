import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  ValidationError,
  ContainerError,
  AuthError,
} from '../../lib/error-types';

describe('AppError', () => {
  it('creates error with all properties', () => {
    const error = new AppError('TEST_ERROR', 400, 'Internal message', 'User message');

    expect(error.code).toBe('TEST_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Internal message');
    expect(error.userMessage).toBe('User message');
    expect(error.name).toBe('AppError');
  });

  it('toJSON returns error object with code', () => {
    const error = new AppError('TEST_ERROR', 400, 'Internal message', 'User message');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'User message',
      code: 'TEST_ERROR',
    });
  });

  it('toJSON falls back to message when userMessage is not provided', () => {
    const error = new AppError('TEST_ERROR', 400, 'Internal message');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'Internal message',
      code: 'TEST_ERROR',
    });
  });

  it('is instanceof Error', () => {
    const error = new AppError('TEST_ERROR', 400, 'message');
    expect(error instanceof Error).toBe(true);
  });
});

describe('NotFoundError', () => {
  it('creates error with resource name only', () => {
    const error = new NotFoundError('Session');

    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Session not found');
    expect(error.userMessage).toBe('Session not found');
  });

  it('creates error with resource name and id', () => {
    const error = new NotFoundError('Session', 'abc123');

    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Session not found: abc123');
    expect(error.userMessage).toBe('Session not found');
  });

  it('toJSON returns correct structure', () => {
    const error = new NotFoundError('User', 'user-123');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'User not found',
      code: 'NOT_FOUND',
    });
  });
});

describe('ValidationError', () => {
  it('creates error with validation message', () => {
    const error = new ValidationError('Invalid session ID format');

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Invalid session ID format');
    expect(error.userMessage).toBe('Invalid session ID format');
  });

  it('toJSON returns correct structure', () => {
    const error = new ValidationError('Name is required');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'Name is required',
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('ContainerError', () => {
  it('creates error with operation only', () => {
    const error = new ContainerError('start');

    expect(error.code).toBe('CONTAINER_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Container start failed');
    expect(error.userMessage).toBe('Container operation failed. Please try again.');
  });

  it('creates error with operation and detail', () => {
    const error = new ContainerError('health check', 'timeout after 30s');

    expect(error.code).toBe('CONTAINER_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Container health check failed: timeout after 30s');
    expect(error.userMessage).toBe('Container operation failed. Please try again.');
  });

  it('toJSON returns user-friendly message', () => {
    const error = new ContainerError('start', 'internal details here');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'Container operation failed. Please try again.',
      code: 'CONTAINER_ERROR',
    });
  });
});

describe('AuthError', () => {
  it('creates error with default message', () => {
    const error = new AuthError();

    expect(error.code).toBe('AUTH_ERROR');
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Authentication required');
    expect(error.userMessage).toBe('Authentication required');
  });

  it('creates error with custom message', () => {
    const error = new AuthError('Token expired');

    expect(error.code).toBe('AUTH_ERROR');
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Token expired');
    expect(error.userMessage).toBe('Authentication required');
  });

  it('toJSON returns user-friendly message', () => {
    const error = new AuthError('Invalid credentials');
    const json = error.toJSON();

    expect(json).toEqual({
      error: 'Authentication required',
      code: 'AUTH_ERROR',
    });
  });
});
