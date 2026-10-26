#!/usr/bin/env python3
"""Generates backend/seed/demo_module.pdf — a small, dependency-free PDF of the demo module text so the
PDF upload path (poppler extraction → structuring) can be exercised without third-party content."""
import os, sys

PAGES = [
"""THE LANTERN OF BLACKWATER COVE
An introductory scenario for Call of Cthulhu / Basic Roleplaying

Introduction
In the autumn of 1925 the fishing town of Blackwater Cove, Massachusetts, is troubled by
lights seen on the water at night and by the disappearance of the lighthouse keeper,
Elias Thorne. The investigators are hired by his sister, Mrs. Agnes Hale.

Keeper's Information
Elias Thorne discovered a drowned idol in the shoals and brought it to the lighthouse.
The Sheriff, Amos Dunmore, is a member of the Lantern Society and will mislead the
investigators while appearing helpful.""",
"""Chapter One: Arrival in Blackwater Cove

Scene: The Sheriff's Office
Sheriff Amos Dunmore receives the investigators politely. He claims he has the only key
to the lighthouse. If the investigators ask for the key, he promises to look for it and
bring it to them later; he never intends to do so. A tarnished badge lies on his desk.

NPC: Sheriff Amos Dunmore
A heavy-set man of fifty. STR 70 CON 65 DEX 45 POW 60 SAN 40. Skills: Persuade 60%.

Scene: Hale Boarding House
Mrs. Agnes Hale offers rooms. She gives the investigators a letter from Elias.
Handout 1: Elias's Letter.""",
"""Chapter Two: The Town

Location: Blackwater Gazette Office
If the investigators search the archive they find a 1911 clipping about a shipwreck and
a photograph of a brass lantern recovered from the wreck.

Location: Blackwater Docks
At night a mysterious figure in oilskins watches the water. He introduces himself as
Jonah Pike and drops a tarnished badge with the lantern sigil when he leaves.

Item: The Lighthouse Key
An iron key. The Sheriff holds it. Only if the investigators obtain the key or break in
can they reach the lighthouse interior.""",
"""Chapter Three: The Lighthouse

Condition: Entering the lighthouse requires the key, a successful Locksmith roll, or
breaking the door.
Scene: The Lighthouse Interior
The lamp room holds the drowned idol. A trapdoor leads to the sea cave.
Twist: The Sheriff's Betrayal
If the investigators show the Sheriff the secret documents, he attempts to have them arrested.
Ending: Dawn at the Cove
If the idol is cast back into the sea, Elias is released and the lights cease.""",
]

def esc(s):
    return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

def page_stream(text):
    ops = ['BT', '/F1 11 Tf', '14 TL', '50 790 Td']
    for ln in text.split('\n'):
        ops.append('(%s) Tj T*' % esc(ln.encode('latin-1', 'replace').decode('latin-1')))
    ops.append('ET')
    return '\n'.join(ops).encode('latin-1')

def build(pages):
    objs = []
    def add(b): objs.append(b); return len(objs)
    font = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    pages_obj = add(b'')
    page_ids = []
    for p in pages:
        stream = page_stream(p)
        content = add(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
        page_ids.append(add(('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>' % (pages_obj, font, content)).encode()))
    objs[pages_obj - 1] = ('<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join('%d 0 R' % i for i in page_ids), len(page_ids))).encode()
    catalog = add(('<< /Type /Catalog /Pages %d 0 R >>' % pages_obj).encode())
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += ('%d 0 obj\n' % i).encode() + o + b'\nendobj\n'
    xref = len(out)
    out += ('xref\n0 %d\n' % (len(objs) + 1)).encode() + b'0000000000 65535 f \n'
    for off in offsets: out += ('%010d 00000 n \n' % off).encode()
    out += ('trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, catalog, xref)).encode()
    return bytes(out)

if __name__ == '__main__':
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'demo_module.pdf')
    with open(dest, 'wb') as f: f.write(build(PAGES))
    print('wrote', dest, os.path.getsize(dest), 'bytes')
