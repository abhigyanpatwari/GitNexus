/**
 * The settings panel's access-token field persists on Save, with every other
 * field, rather than on each keystroke. Save is the only "committed" affordance
 * the panel has, and a half-typed token would otherwise ride the next probe to
 * the backend.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../../src/components/SettingsPanel';
import { i18nReady } from '../../src/i18n';
import { getAuthToken, setAuthToken } from '../../src/services/backend-client';

const TOKEN = 'deploy-token-abc123';

describe('SettingsPanel access token', () => {
  beforeEach(async () => {
    await i18nReady;
    setAuthToken('');
  });

  afterEach(() => {
    setAuthToken('');
  });

  it('holds a typed token locally until Save', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isOpen onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('Access Token'), TOKEN);
    expect(getAuthToken()).toBe('');

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(getAuthToken()).toBe(TOKEN);
  });

  it('clears a stored token when the field is emptied and saved', async () => {
    setAuthToken(TOKEN);
    const user = userEvent.setup();
    render(<SettingsPanel isOpen onClose={vi.fn()} />);

    await user.clear(screen.getByLabelText('Access Token'));
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    // An empty token is a valid state — an ungated local backend needs no header.
    expect(getAuthToken()).toBe('');
  });
});
