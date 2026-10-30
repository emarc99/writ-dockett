"""Build the forged-order demo fixture.

Takes the genuine Newton v. Ermilov TRO (N.D. Cal. 5:26-cv-05055, ECF 18) and
"whites out" the fifth frozen wallet, typing an attacker-chosen address over it.
The result looks like the real order but its bytes (and SHA-1) differ from the
copy on the federal docket, and the swapped wallet does not appear in the
official text - the two signals Writ's verify workflow checks.
"""
import hashlib
import pathlib

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "fixtures/newton-v-ermilov/entry-18.genuine.pdf"
DST = ROOT / "fixtures/newton-v-ermilov/entry-18.forged.pdf"

GENUINE_WALLET = "0xe497285e466227f4e8648209e34b465daa1f90a0"
ATTACKER_WALLET = "0x4c1f0b2d9e8a7f6c3b5a49d8e7f60a1b2c3d4e5f"
LINE_Y = 446.89  # baseline of the 5th bullet on page 2 (from pypdf text visitor)
TEXT_X = 207.0

reader = PdfReader(SRC)
writer = PdfWriter(clone_from=reader)
page = writer.pages[1]

fonts = page["/Resources"]["/Font"]
fonts[NameObject("/FX")] = writer._add_object(DictionaryObject({
    NameObject("/Type"): NameObject("/Font"),
    NameObject("/Subtype"): NameObject("/Type1"),
    NameObject("/BaseFont"): NameObject("/Times-Roman"),
}))

overlay = DecodedStreamObject()
overlay.set_data(
    (
        f"q 1 1 1 rg {TEXT_X - 2} {LINE_Y - 4} 300 16 re f Q\n"
        f"BT /FX 12 Tf 0 0 0 rg {TEXT_X} {LINE_Y} Td ({ATTACKER_WALLET}; and) Tj ET\n"
    ).encode()
)
contents = page.get_contents()
contents.set_data(contents.get_data() + b"\n" + overlay.get_data())
page.replace_contents(contents)

with open(DST, "wb") as f:
    writer.write(f)

for p in (SRC, DST):
    print(p.name, hashlib.sha1(p.read_bytes()).hexdigest())
print("swapped", GENUINE_WALLET, "->", ATTACKER_WALLET)
