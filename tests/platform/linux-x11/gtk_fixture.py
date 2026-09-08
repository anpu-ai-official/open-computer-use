#!/usr/bin/python3
import pathlib
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


mode = sys.argv[1]
identifier = sys.argv[2] if len(sys.argv) > 2 else ""
window = Gtk.Window()
window.set_default_size(420, 220)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(24)
window.add(box)

if mode == "target":
    suffix = f" {identifier}" if identifier else ""
    window.set_title(f"OCU Linux Target{suffix}")
    entry = Gtk.Entry()
    entry.set_placeholder_text("Payload")
    entry.get_accessible().set_name("Payload entry")
    button = Gtk.Button(label="Commit payload")
    status = Gtk.Label(label="idle")
    status.get_accessible().set_name("Result status")

    def commit(_button):
        value = entry.get_text()
        output = f"/tmp/ocu-result-{identifier}.txt" if identifier else "/tmp/ocu-result.txt"
        pathlib.Path(output).write_text(value, encoding="utf-8")
        status.set_text(f"committed:{value}")
        status.get_accessible().set_name(f"committed:{value}")

    button.connect("clicked", commit)
    box.pack_start(entry, False, False, 0)
    box.pack_start(button, False, False, 0)
    box.pack_start(status, False, False, 0)
else:
    window.set_title("OCU Focus Sentinel")
    box.pack_start(Gtk.Label(label="This window must stay focused"), True, True, 0)

window.show_all()
Gtk.main()
