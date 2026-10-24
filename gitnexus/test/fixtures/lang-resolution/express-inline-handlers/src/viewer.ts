import { request } from 'http-client';

// A proven consumer is not counted again as an unverified one.
export const showFile = () => fetch('/api/file');
export const showFileAgain = () => request('/api/file');
