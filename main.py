import os
import sys
import json
import hashlib
import subprocess
import threading
import tkinter as tk
from tkinter.scrolledtext import ScrolledText
import shutil
import psutil
import requests
import time

# ---------------- Paths & NPX ----------------
NPX_CMD = shutil.which("npx")
if NPX_CMD is None:
    raise RuntimeError("❌ npx not found in PATH. Install Node.js first.")

# ---------------- App directory logic ----------------
if getattr(sys, "frozen", False):
    # Running as .exe
    APP_DIR = os.path.dirname(os.path.dirname(sys.executable))  # go up from dist/
else:
    # Running as .py script
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Path to the TypeScript automation script
TS_SCRIPT_PATH = os.path.join(APP_DIR, "src", "main.ts")
if not os.path.exists(TS_SCRIPT_PATH):
    raise FileNotFoundError(f"❌ Cannot find main.ts at {TS_SCRIPT_PATH}")

# Users file
USERS_FILE = os.path.join(APP_DIR, "users.json")
if not os.path.exists(USERS_FILE):
    with open(USERS_FILE, "w") as f:
        json.dump({}, f)

automation_process = None

# --- Paths ---

REPO_URL = "https://github.com/Mher0919/Ideal-Choice-Home-Health.git"
APP_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))  # your app folder
TMP_DIR = APP_DIR + "_tmp_update"
EXE_NAME = os.path.basename(sys.argv[0])  # running exe

# ---------------- Auto-Update ----------------
LOCAL_VERSION = "1.0.0"  # Update this whenever you rebuild the exe
VERSION_URL = "https://raw.githubusercontent.com/Mher0919/Ideal-Choice-Home-Health/main/version.txt"
EXE_URL_TEMPLATE = "https://raw.githubusercontent.com/Mher0919/Ideal-Choice-Home-Health/main/dist/main.exe"


# ---------------- Helpers ----------------
def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def verify_user(email, password):
    with open(USERS_FILE, "r") as f:
        users = json.load(f)
    return email in users and users[email] == hash_password(password)

def register_user(email, password):
    with open(USERS_FILE, "r") as f:
        users = json.load(f)
    if email in users:
        return False
    users[email] = hash_password(password)
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)
    return True

def kill_process_tree(pid):
    try:
        parent = psutil.Process(pid)
        for child in parent.children(recursive=True):
            child.kill()
        parent.kill()
    except psutil.NoSuchProcess:
        pass

# ---------------- Automation ----------------
def run_automation(log_widget, status_label):
    global automation_process
    automation_process = subprocess.Popen(
        [NPX_CMD, "ts-node", TS_SCRIPT_PATH],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1
    )
    for line in automation_process.stdout:
        line_lower = line.lower()
        if "error" in line_lower:
            log_widget.insert(tk.END, line, "error")
        elif "finished" in line_lower or "✅" in line_lower:
            log_widget.insert(tk.END, line, "success")
        else:
            log_widget.insert(tk.END, line, "info")
        log_widget.see(tk.END)

    automation_process.stdout.close()
    automation_process.wait()
    automation_process = None
    log_widget.insert(tk.END, "\n✅ Automation finished!\n", "success")
    status_label.config(text="Stopped")
    log_widget.see(tk.END)

def start_button_clicked(log_widget, start_btn, stop_btn, status_label, indicator):
    start_btn.config(state=tk.DISABLED)
    stop_btn.config(state=tk.NORMAL)
    status_label.config(text="Running")
    indicator.start_animation()
    log_widget.insert(tk.END, "🚀 Starting automation...\n", "info")
    log_widget.see(tk.END)

    def target():
        try:
            run_automation(log_widget, status_label)
        except Exception as e:
            log_widget.insert(tk.END, f"\n❌ Error: {str(e)}\n", "error")
        finally:
            start_btn.config(state=tk.NORMAL)
            stop_btn.config(state=tk.DISABLED)
            indicator.stop_animation()

    threading.Thread(target=target, daemon=True).start()

def stop_button_clicked(log_widget, stop_btn, status_label, indicator):
    global automation_process
    if automation_process and automation_process.poll() is None:
        kill_process_tree(automation_process.pid)
        log_widget.insert(tk.END, "\n🛑 Automation stopped by user.\n", "error")
        log_widget.see(tk.END)
        stop_btn.config(state=tk.DISABLED)
        status_label.config(text="Stopped")
        indicator.stop_animation()
def update_app(log_widget):
    """Pull latest version from GitHub and update local files"""
    log_widget.insert(tk.END, "🔄 Checking for updates...\n")
    log_widget.see(tk.END)

    # Check if git is installed
    if shutil.which("git") is None:
        messagebox.showerror("Error", "Git is not installed on this PC.")
        return

    # Determine whether to pull or clone
    git_dir = os.path.join(APP_DIR, ".git")
    tmp_dir = None  # default
    if os.path.exists(git_dir):
        cmd = ["git", "-C", APP_DIR, "pull"]
    else:
        tmp_dir = APP_DIR + "_tmp_update"
        if os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir)
        cmd = ["git", "clone", REPO_URL, tmp_dir]

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for line in process.stdout:
            log_widget.insert(tk.END, line)
            log_widget.see(tk.END)
        process.wait()

        # Only copy from tmp_dir if we cloned
        if tmp_dir and os.path.exists(tmp_dir):
            for item in os.listdir(tmp_dir):
                src_path = os.path.join(tmp_dir, item)
                dst_path = os.path.join(APP_DIR, item)
                if os.path.isdir(src_path):
                    if os.path.exists(dst_path):
                        shutil.rmtree(dst_path)
                    shutil.copytree(src_path, dst_path)
                else:
                    shutil.copy2(src_path, dst_path)
            shutil.rmtree(tmp_dir)

        log_widget.insert(tk.END, "\n✅ App updated successfully!\n")
        log_widget.see(tk.END)
        messagebox.showinfo("Update", "App updated! Please restart to apply changes.")
    except Exception as e:
        log_widget.insert(tk.END, f"\n❌ Update failed: {str(e)}\n")
        log_widget.see(tk.END)
        messagebox.showerror("Update Error", f"Update failed: {str(e)}")

def auto_update(log_widget):
    """Update the full project folder safely from GitHub."""
    def run_update():
        try:
            log_widget.insert(tk.END, "🔄 Checking for updates...\n")
            log_widget.see(tk.END)

            # Make sure git is installed
            if shutil.which("git") is None:
                messagebox.showerror("Error", "Git is not installed on this PC.")
                return

            # Clone repo to temporary folder
            if os.path.exists(TMP_DIR):
                shutil.rmtree(TMP_DIR)
            subprocess.check_call(["git", "clone", REPO_URL, TMP_DIR])

            # Copy all files except running exe
            for item in os.listdir(TMP_DIR):
                src_path = os.path.join(TMP_DIR, item)
                dst_path = os.path.join(APP_DIR, item)

                if os.path.abspath(dst_path) == os.path.abspath(sys.argv[0]):
                    continue  # skip running exe

                if os.path.isdir(src_path):
                    if os.path.exists(dst_path):
                        shutil.rmtree(dst_path)
                    shutil.copytree(src_path, dst_path)
                else:
                    shutil.copy2(src_path, dst_path)

            # Remove temp folder
            shutil.rmtree(TMP_DIR)

            log_widget.insert(tk.END, "✅ Project updated successfully!\n")
            log_widget.see(tk.END)

            # Replace running exe safely via batch
            new_exe_path = os.path.join(APP_DIR, EXE_NAME)
            bat_path = os.path.join(APP_DIR, "update.bat")
            with open(bat_path, "w") as f:
                f.write(f"""@echo off
timeout /t 2
start "" "{new_exe_path}"
exit
""")
            log_widget.insert(tk.END, "🔄 Restarting app to apply updates...\n")
            subprocess.Popen([bat_path], shell=True)
            sys.exit()

        except Exception as e:
            log_widget.insert(tk.END, f"❌ Update failed: {str(e)}\n")
            log_widget.see(tk.END)
            messagebox.showerror("Update Error", f"Update failed: {str(e)}")

    threading.Thread(target=run_update, daemon=True).start()

# ---------------- Animated Indicator ----------------
class RunningIndicator(tk.Canvas):
    def __init__(self, parent, size=20):
        super().__init__(parent, width=size, height=size, bg="#1e1e2f", highlightthickness=0)
        self.size = size
        self.dot = self.create_oval(2, 2, size-2, size-2, fill="#0ff", outline="")
        self.running = False
        self.angle = 0

    def start_animation(self):
        self.running = True
        self.animate()

    def stop_animation(self):
        self.running = False
        self.itemconfig(self.dot, fill="#555")

    def animate(self):
        if not self.running:
            return
        self.angle += 0.2
        self.after(80, self.animate)

# ---------------- Tkinter GUI Setup ----------------
root = tk.Tk()
root.title("🌌 Ideal Choice Home Health Home")
root.geometry("1000x650")
root.configure(bg="#1e1e2f")

# --- Frames ---
login_frame = tk.Frame(root, bg="#1e1e2f")
automation_frame = tk.Frame(root, bg="#1e1e2f")
for frame in (login_frame, automation_frame):
    frame.place(relwidth=1, relheight=1)

# ---------------- Login/Register ----------------
with open(USERS_FILE, "r") as f:
    try:
        users_data = json.load(f)
    except json.JSONDecodeError:
        users_data = {}
require_registration = len(users_data) == 0

tk.Label(login_frame, text="🌌 Login", font=("Segoe UI", 28, "bold"), fg="#ffffff", bg="#1e1e2f").pack(pady=40)

def create_entry(parent, placeholder, show=None):
    entry = tk.Entry(parent, font=("Segoe UI", 16), fg="#ffffff", bg="#2a2a2f", insertbackground="white",
                     bd=2, relief=tk.FLAT, width=30)
    entry.pack(pady=10)
    entry.insert(0, placeholder)
    entry.bind("<FocusIn>", lambda e: entry.delete(0, tk.END) if entry.get() == placeholder else None)
    entry.bind("<FocusOut>", lambda e: entry.insert(0, placeholder) if entry.get() == "" else None)
    if show:
        entry.config(show=show)
    return entry

email_entry = create_entry(login_frame, "Email")
password_entry = create_entry(login_frame, "Password", show="*")

login_msg = tk.Label(login_frame, text="", font=("Segoe UI", 12), fg="#ff4c4c", bg="#1e1e2f")
login_msg.pack(pady=5)

def login_action():
    email = email_entry.get().strip()
    password = password_entry.get().strip()
    if verify_user(email, password):
        login_frame.lower()
        automation_frame.lift()
    else:
        login_msg.config(text="❌ Invalid login")

def register_action():
    email = email_entry.get().strip()
    password = password_entry.get().strip()
    if register_user(email, password):
        login_msg.config(text="✅ Registered! Now login.", fg="#00ff88")
        show_login_button()
    else:
        login_msg.config(text="❌ User already exists", fg="#ff4c4c")

def show_login_button():
    for widget in login_frame.winfo_children():
        if hasattr(widget, "is_auth_button"):
            widget.destroy()
    btn = tk.Button(login_frame, text="Login", font=("Segoe UI", 16), bg="#5c5cff", fg="white",
                    command=login_action)
    btn.is_auth_button = True
    btn.pack(pady=5)

def show_register_button():
    for widget in login_frame.winfo_children():
        if hasattr(widget, "is_auth_button"):
            widget.destroy()
    btn = tk.Button(login_frame, text="Register", font=("Segoe UI", 16), bg="#ff9f5c", fg="white",
                    command=register_action)
    btn.is_auth_button = True
    btn.pack(pady=5)
if require_registration:
    show_register_button()
else:
    show_login_button()

# ---------------- Automation UI ----------------
header = tk.Frame(automation_frame, bg="#2a2a5f", height=70)
header.pack(fill=tk.X)
tk.Label(header, text="🌌 Ideal Choice Home Health Homeeeeeeee", font=("Segoe UI", 28, "bold"), fg="#ffffff", bg="#2a2a5f").pack(pady=15)

btn_frame = tk.Frame(automation_frame, bg="#1e1e2f")
btn_frame.pack(pady=15)

status_label = tk.Label(automation_frame, text="Stopped", font=("Segoe UI", 14, "bold"), bg="#1e1e2f", fg="#cccccc")
status_label.pack(pady=(0,10))

indicator = RunningIndicator(automation_frame)
indicator.pack(pady=5)

def create_button(parent, text, command, bg="#5c5cff", fg="white"):
    return tk.Button(
        parent, text=text, font=("Segoe UI", 16, "bold"),
        bg=bg, fg=fg, activebackground="#3a3aff", activeforeground="white",
        bd=0, relief=tk.RAISED, padx=25, pady=10, command=command
    )

start_btn = create_button(btn_frame, "Start 🚀", lambda: start_button_clicked(log_area, start_btn, stop_btn, status_label, indicator))
start_btn.pack(side=tk.LEFT, padx=15)

stop_btn = create_button(btn_frame, "Stop 🛑", lambda: stop_button_clicked(log_area, stop_btn, status_label, indicator), bg="#ff4c4c")
stop_btn.pack(side=tk.LEFT, padx=15)
stop_btn.config(state=tk.DISABLED)

update_btn = tk.Button(
    btn_frame, text="Update App ⬆️", font=("Segoe UI", 16, "bold"),
    bg="#00ccff", fg="white", bd=0, padx=25, pady=10,
    command=lambda: update_app(log_area)
)
update_btn.pack(side=tk.LEFT, padx=15)

# ---------------- Change Password ----------------
def change_password_action():
    def submit_change():
        current_pw = current_entry.get().strip()
        new_pw = new_entry.get().strip()
        confirm_pw = confirm_entry.get().strip()

        if not verify_user(email_entry.get().strip(), current_pw):
            msg_label.config(text="❌ Current password incorrect", fg="#ff4c4c")
            return
        if new_pw != confirm_pw:
            msg_label.config(text="❌ New passwords do not match", fg="#ff4c4c")
            return
        if len(new_pw) < 6:
            msg_label.config(text="❌ Password must be at least 6 characters", fg="#ff4c4c")
            return

        # Update password in users.json
        with open(USERS_FILE, "r") as f:
            users = json.load(f)
        users[email_entry.get().strip()] = hash_password(new_pw)
        with open(USERS_FILE, "w") as f:
            json.dump(users, f, indent=2)
        msg_label.config(text="✅ Password changed successfully!", fg="#00ff88")
        pw_window.destroy()

    # Create modal window
    # Create modal window
    pw_window = tk.Toplevel(root)
    pw_window.title("Change Password 🔑")
    pw_window.geometry("400x450")  # taller window
    pw_window.configure(bg="#1e1e2f")
    pw_window.grab_set()  # make modal

    tk.Label(pw_window, text="🌌 Change Password", font=("Segoe UI", 20, "bold"), fg="#ffffff", bg="#1e1e2f").pack(pady=10)

    # Sections
    tk.Label(pw_window, text="Current Password", font=("Segoe UI", 14), fg="#00ffff", bg="#1e1e2f").pack(pady=(10,2))
    current_entry = tk.Entry(pw_window, font=("Segoe UI", 14), show="*", bg="#2a2a2a", fg="white", bd=2, relief=tk.FLAT)
    current_entry.pack(pady=(0,5), fill=tk.X, padx=20)

    tk.Label(pw_window, text="New Password", font=("Segoe UI", 14), fg="#00ffff", bg="#1e1e2f").pack(pady=(10,2))
    new_entry = tk.Entry(pw_window, font=("Segoe UI", 14), show="*", bg="#2a2a2a", fg="white", bd=2, relief=tk.FLAT)
    new_entry.pack(pady=(0,5), fill=tk.X, padx=20)

    tk.Label(pw_window, text="Confirm New Password", font=("Segoe UI", 14), fg="#00ffff", bg="#1e1e2f").pack(pady=(10,2))
    confirm_entry = tk.Entry(pw_window, font=("Segoe UI", 14), show="*", bg="#2a2a2a", fg="white", bd=2, relief=tk.FLAT)
    confirm_entry.pack(pady=(0,5), fill=tk.X, padx=20)

    msg_label = tk.Label(pw_window, text="", font=("Segoe UI", 12), fg="#00ff88", bg="#1e1e2f")
    msg_label.pack(pady=10)

    # Submit button
    tk.Button(
        pw_window, text="Submit", font=("Segoe UI", 14, "bold"),
        bg="#5c5cff", fg="white", bd=0, padx=20, pady=10, command=submit_change
    ).pack(pady=15, fill=tk.X, padx=50)
# Add Change Password button to btn_frame
change_pw_btn = create_button(btn_frame, "Change Password 🔑", change_password_action, bg="#ffaa00")
change_pw_btn.pack(side=tk.LEFT, padx=15)


log_area = ScrolledText(
    automation_frame, font=("Consolas", 13), bg="#121212", fg="#00ffcc",
    insertbackground="white", wrap=tk.WORD, bd=2, relief=tk.FLAT
)
log_area.pack(expand=True, fill="both", padx=20, pady=10)
log_area.tag_config("error", foreground="#ff4c4c")
log_area.tag_config("success", foreground="#00ff88")
log_area.tag_config("info", foreground="#ffffff")

# --- Footer ---
footer = tk.Label(automation_frame, text="Designed by Mher Mkrtumyan", font=("Segoe UI", 10),
                  bg="#2a2a5f", fg="#ffffff", pady=5)
footer.pack(fill=tk.X, side=tk.BOTTOM)

# --- Show login first ---
login_frame.lift()

# Start auto-update check in background thread (non-blocking)
threading.Thread(target=lambda: auto_update(log_area), daemon=True).start()
root.mainloop()
