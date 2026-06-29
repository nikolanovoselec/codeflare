/**
 * REQ-ENTERPRISE-019: view-only storage notice. When downloads are disabled, an
 * interaction with a blocked download control raises this popup instead of letting
 * the request reach the server (which would 403 and "look broken"). Assertions are
 * by data-testid and store state — never by message copy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import DownloadsDisabledPopup from '../../components/DownloadsDisabledPopup';
import { storageStore } from '../../stores/storage';

describe('DownloadsDisabledPopup', () => {
  afterEach(() => {
    storageStore.dismissDownloadsNotice();
    cleanup();
  });

  it('is not rendered while the notice is closed', () => {
    storageStore.dismissDownloadsNotice();
    render(() => <DownloadsDisabledPopup />);
    expect(screen.queryByTestId('downloads-disabled-popup')).not.toBeInTheDocument();
  });

  it('renders the notice when storageStore.downloadsNoticeOpen is set', () => {
    storageStore.showDownloadsNotice();
    render(() => <DownloadsDisabledPopup />);
    const popup = screen.getByTestId('downloads-disabled-popup');
    expect(popup).toBeInTheDocument();
    // contract: it is an actual modal dialog
    expect(popup.getAttribute('aria-modal')).toBe('true');
  });

  it('dismiss button closes the notice (store flag false, popup removed)', () => {
    storageStore.showDownloadsNotice();
    render(() => <DownloadsDisabledPopup />);

    fireEvent.click(screen.getByTestId('downloads-disabled-dismiss'));

    expect(storageStore.downloadsNoticeOpen).toBe(false);
    expect(screen.queryByTestId('downloads-disabled-popup')).not.toBeInTheDocument();
  });

  it('backdrop click closes the notice', () => {
    storageStore.showDownloadsNotice();
    render(() => <DownloadsDisabledPopup />);

    fireEvent.click(screen.getByTestId('downloads-disabled-backdrop'));

    expect(storageStore.downloadsNoticeOpen).toBe(false);
  });

  it('Escape key closes the notice (store flag false, popup removed)', () => {
    storageStore.showDownloadsNotice();
    render(() => <DownloadsDisabledPopup />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(storageStore.downloadsNoticeOpen).toBe(false);
    expect(screen.queryByTestId('downloads-disabled-popup')).not.toBeInTheDocument();
  });
});
