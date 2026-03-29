#!/usr/bin/env python3
"""
Discord Soundboard — Global Hotkey Companion
GUI app with system-wide keyboard shortcuts for controlling the soundboard.
Works on Windows and Linux. Uses tkinter (built into Python) for the GUI.

Setup:
  pip install keyboard requests
  python companion/hotkeys.py
"""

import os
import sys
import json
import threading
import tkinter as tk
from tkinter import ttk, messagebox

# --- .env loader ---
def load_env(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, v = line.partition('=')
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, '.env')
CONFIG_PATH = os.path.join(SCRIPT_DIR, 'config.json')

load_env(ENV_PATH)

# --- Config persistence ---
DEFAULT_CONFIG = {
    'url': os.environ.get('SOUNDBOARD_URL', 'http://localhost:3000'),
    'token': os.environ.get('COMPANION_TOKEN', ''),
    'bindings': {
        'stop': os.environ.get('STOP_KEY', 's'),
        'pause': os.environ.get('PAUSE_KEY', 'space'),
    },
    'enabled': True,
}

def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                saved = json.load(f)
            # Merge with defaults for any missing keys
            cfg = {**DEFAULT_CONFIG, **saved}
            cfg['bindings'] = {**DEFAULT_CONFIG['bindings'], **saved.get('bindings', {})}
            return cfg
        except Exception:
            pass
    return dict(DEFAULT_CONFIG)

def save_config(cfg):
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)

# --- API calls ---
def api_call(cfg, method, path):
    try:
        import requests
        headers = {'Authorization': f'Bearer {cfg["token"]}', 'Content-Type': 'application/json'}
        r = requests.request(method, cfg['url'].rstrip('/') + path, headers=headers, timeout=5)
        return r
    except Exception as e:
        return None

def do_stop(cfg):
    api_call(cfg, 'POST', '/api/stop')

def do_pause_resume(cfg):
    r = api_call(cfg, 'GET', '/api/playback-state')
    if not r or not r.ok:
        return
    status = r.json().get('status')
    if status == 'playing':
        api_call(cfg, 'POST', '/api/pause')
    elif status == 'paused':
        api_call(cfg, 'POST', '/api/resume')


class CompanionApp:
    def __init__(self, root):
        self.root = root
        self.root.title('Soundboard Companion')
        self.root.resizable(False, False)
        self.cfg = load_config()
        self.keyboard = None
        self.hotkeys_registered = []
        self.recording_action = None  # which action we're recording a new key for

        try:
            import keyboard
            self.keyboard = keyboard
        except ImportError:
            messagebox.showerror('Missing dependency',
                'The "keyboard" library is not installed.\n\n'
                'Run: pip install keyboard requests\n\n'
                'Then restart this app.')
            sys.exit(1)

        try:
            import requests
        except ImportError:
            messagebox.showerror('Missing dependency',
                'The "requests" library is not installed.\n\n'
                'Run: pip install keyboard requests\n\n'
                'Then restart this app.')
            sys.exit(1)

        self._build_ui()
        self._apply_hotkeys()

    def _build_ui(self):
        pad = {'padx': 10, 'pady': 5}

        # --- Connection section ---
        conn_frame = ttk.LabelFrame(self.root, text='Connection', padding=10)
        conn_frame.pack(fill='x', **pad)

        ttk.Label(conn_frame, text='Soundboard URL:').grid(row=0, column=0, sticky='w')
        self.url_var = tk.StringVar(value=self.cfg['url'])
        ttk.Entry(conn_frame, textvariable=self.url_var, width=40).grid(row=0, column=1, padx=(5, 0))

        ttk.Label(conn_frame, text='Companion Token:').grid(row=1, column=0, sticky='w', pady=(5, 0))
        self.token_var = tk.StringVar(value=self.cfg['token'])
        ttk.Entry(conn_frame, textvariable=self.token_var, width=40, show='*').grid(row=1, column=1, padx=(5, 0), pady=(5, 0))

        self.status_label = ttk.Label(conn_frame, text='', foreground='gray')
        self.status_label.grid(row=2, column=0, columnspan=2, sticky='w', pady=(5, 0))

        ttk.Button(conn_frame, text='Test Connection', command=self._test_connection).grid(row=2, column=1, sticky='e', pady=(5, 0))

        # --- Hotkeys section ---
        keys_frame = ttk.LabelFrame(self.root, text='Hotkeys', padding=10)
        keys_frame.pack(fill='x', **pad)

        self.binding_vars = {}
        self.binding_btns = {}
        actions = [('stop', 'Stop'), ('pause', 'Pause / Resume')]
        for i, (action, label) in enumerate(actions):
            ttk.Label(keys_frame, text=f'{label}:').grid(row=i, column=0, sticky='w')
            var = tk.StringVar(value=self.cfg['bindings'].get(action, ''))
            self.binding_vars[action] = var
            lbl = ttk.Label(keys_frame, textvariable=var, width=15, relief='sunken', anchor='center')
            lbl.grid(row=i, column=1, padx=5)
            btn = ttk.Button(keys_frame, text='Set', width=5,
                             command=lambda a=action: self._start_recording(a))
            btn.grid(row=i, column=2)
            self.binding_btns[action] = btn

        # --- Enable / Disable ---
        ctrl_frame = ttk.Frame(self.root, padding=10)
        ctrl_frame.pack(fill='x')

        self.enabled_var = tk.BooleanVar(value=self.cfg.get('enabled', True))
        self.toggle_btn = ttk.Checkbutton(ctrl_frame, text='Hotkeys enabled',
                                           variable=self.enabled_var,
                                           command=self._toggle_enabled)
        self.toggle_btn.pack(side='left')

        ttk.Button(ctrl_frame, text='Save', command=self._save).pack(side='right')

        self._update_status()

    def _update_status(self):
        if self.cfg.get('enabled', True):
            bindings = self.cfg['bindings']
            parts = []
            if bindings.get('stop'):
                parts.append(f"Stop: {bindings['stop']}")
            if bindings.get('pause'):
                parts.append(f"Pause: {bindings['pause']}")
            self.status_label.config(text='Active — ' + ', '.join(parts) if parts else 'Active — no keys bound',
                                      foreground='green')
        else:
            self.status_label.config(text='Hotkeys disabled', foreground='gray')

    def _test_connection(self):
        url = self.url_var.get().strip().rstrip('/')
        token = self.token_var.get().strip()
        if not url or not token:
            messagebox.showwarning('Missing info', 'Enter both URL and token.')
            return
        test_cfg = {'url': url, 'token': token}
        r = api_call(test_cfg, 'GET', '/api/playback-state')
        if r and r.ok:
            messagebox.showinfo('Success', f'Connected to {url}')
        elif r:
            messagebox.showerror('Error', f'Server responded with {r.status_code}.\nCheck your token.')
        else:
            messagebox.showerror('Error', f'Could not connect to {url}.\nCheck the URL and make sure the server is running.')

    def _start_recording(self, action):
        self.recording_action = action
        self.binding_vars[action].set('Press a key...')
        self.binding_btns[action].config(state='disabled')
        # Record next key press
        self.keyboard.on_press(self._on_key_recorded, suppress=False)

    def _on_key_recorded(self, event):
        if self.recording_action is None:
            return
        action = self.recording_action
        self.recording_action = None
        key_name = event.name
        self.root.after(0, lambda: self._finish_recording(action, key_name))

    def _finish_recording(self, action, key_name):
        self.keyboard.unhook_all()
        self.binding_vars[action].set(key_name)
        self.binding_btns[action].config(state='normal')
        self.cfg['bindings'][action] = key_name
        self._apply_hotkeys()
        self._update_status()

    def _toggle_enabled(self):
        self.cfg['enabled'] = self.enabled_var.get()
        self._apply_hotkeys()
        self._update_status()

    def _apply_hotkeys(self):
        # Remove all existing hotkeys
        for hk in self.hotkeys_registered:
            try:
                self.keyboard.remove_hotkey(hk)
            except (ValueError, KeyError):
                pass
        self.hotkeys_registered = []

        if not self.cfg.get('enabled', True):
            return

        bindings = self.cfg['bindings']
        cfg = self.cfg

        if bindings.get('stop'):
            try:
                hk = self.keyboard.add_hotkey(bindings['stop'], lambda: threading.Thread(target=do_stop, args=(cfg,), daemon=True).start())
                self.hotkeys_registered.append(hk)
            except Exception:
                pass

        if bindings.get('pause'):
            try:
                hk = self.keyboard.add_hotkey(bindings['pause'], lambda: threading.Thread(target=do_pause_resume, args=(cfg,), daemon=True).start())
                self.hotkeys_registered.append(hk)
            except Exception:
                pass

    def _save(self):
        self.cfg['url'] = self.url_var.get().strip()
        self.cfg['token'] = self.token_var.get().strip()
        self.cfg['enabled'] = self.enabled_var.get()
        # bindings already updated by _finish_recording
        save_config(self.cfg)
        self._apply_hotkeys()
        self._update_status()
        self.status_label.config(text='Saved!', foreground='blue')
        self.root.after(2000, self._update_status)


def main():
    root = tk.Tk()
    app = CompanionApp(root)
    root.mainloop()

if __name__ == '__main__':
    main()
