import { ui } from '../i18n.js';
import { el, on, show, text } from './dom.js';
export class MessageDialog {
  private resolve: ((result: boolean) => void) | null = null;
  constructor() {
    on('message-confirm', () => this.close(true));
    on('message-cancel', () => this.close(false));
    on('message-close', () => this.close(false));
    el<HTMLDialogElement>('message-dialog').addEventListener('cancel', (event) => { event.preventDefault(); this.close(false); });
  }
  ask(title: string, body: string, confirm = ui('Продолжить'), dangerous = false): Promise<boolean> {
    return this.open(title, body, confirm, true, dangerous);
  }
  info(title: string, body: string): Promise<boolean> { return this.open(title, body, ui('Понятно'), false, false); }
  private open(title: string, body: string, confirm: string, cancel: boolean, dangerous: boolean): Promise<boolean> {
    if (this.resolve) this.close(false);
    text('message-title', title); text('message-body', body); text('message-confirm', confirm);
    el('message-confirm').className = dangerous ? 'danger' : 'primary';
    show('message-cancel', cancel);
    el<HTMLDialogElement>('message-dialog').showModal();
    (cancel ? el('message-cancel') : el('message-confirm')).focus();
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  private close(result: boolean): void {
    el<HTMLDialogElement>('message-dialog').close(); this.resolve?.(result); this.resolve = null;
  }
}
