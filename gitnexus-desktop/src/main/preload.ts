import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('gitnexusDesktop', {});