// stamper: writes a certified, stamped PDF from a plain-text affidavit.
// usage: stamper in.txt out.pdf CASE_REF OFFICER "DATE" SHA256
#include <bits/stdc++.h>
using namespace std;
static string esc(const string& s) {
  string o;
  for (unsigned char c : s) {
    if (c == '(' || c == ')' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c >= 32 && c < 127) o += (char)c;
    else if (c == '\t') o += "    ";
    else if (c >= 128) o += '?';
  }
  return o;
}
static vector<string> wrap(const string& t, size_t w) {
  vector<string> L; stringstream ss(t); string line;
  while (getline(ss, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    while (line.size() > w) {
      size_t p = line.rfind(' ', w); if (p == string::npos || p == 0) p = w;
      L.push_back(line.substr(0, p)); line = line.substr(line[p] == ' ' ? p + 1 : p);
    }
    L.push_back(line);
  }
  return L;
}
int main(int argc, char** argv) {
  if (argc < 7) { cerr << "usage: stamper in out ref officer date sha256\n"; return 2; }
  ifstream f(argv[1], ios::binary); if (!f) return 3;
  string txt((istreambuf_iterator<char>(f)), {});
  string ref = esc(argv[3]), officer = esc(argv[4]), date = esc(argv[5]), sha = esc(argv[6]);
  auto L = wrap(txt, 88); const size_t PER = 42;
  size_t pages = max<size_t>(1, (L.size() + PER - 1) / PER);
  string out = "%PDF-1.4\n"; vector<size_t> off;
  auto add = [&](const string& b) { off.push_back(out.size()); out += to_string(off.size()) + " 0 obj\n" + b + "\nendobj\n"; };
  string kids; for (size_t i = 0; i < pages; i++) kids += to_string(5 + 2 * i) + " 0 R ";
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [" + kids + "] /Count " + to_string(pages) + " >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  for (size_t i = 0; i < pages; i++) {
    string s = "BT /F2 14 Tf 50 800 Td (SWORN AFFIDAVIT - CASE " + ref + ") Tj ET\n";
    s += "BT /F1 10 Tf 14 TL 50 770 Td\n";
    for (size_t j = i * PER; j < min(L.size(), (i + 1) * PER); j++) s += "(" + esc(L[j]) + ") Tj T*\n";
    s += "ET\nBT /F1 8 Tf 50 30 Td (Page " + to_string(i + 1) + " of " + to_string(pages) + ") Tj ET\n";
    if (i == pages - 1) {
      s += "0.78 0.2 0.12 RG 0.78 0.2 0.12 rg 2 w 50 62 m 360 62 l 360 150 l 50 150 l h S\n";
      s += "BT /F2 15 Tf 62 130 Td (CERTIFIED TRUE COPY) Tj ET\n";
      s += "BT /F1 9 Tf 12 TL 62 112 Td (Certified by: " + officer + ") Tj T* (Date: " + date + ") Tj T* (Case: " + ref + ") Tj T* (SHA-256: " + sha.substr(0, 32) + ") Tj T* (" + sha.substr(32) + ") Tj ET\n";
    }
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + to_string(6 + 2 * i) + " 0 R >>");
    add("<< /Length " + to_string(s.size()) + " >>\nstream\n" + s + "endstream");
  }
  size_t xr = out.size(); char buf[32];
  out += "xref\n0 " + to_string(off.size() + 1) + "\n0000000000 65535 f \n";
  for (size_t o : off) { snprintf(buf, sizeof buf, "%010zu 00000 n \n", o); out += buf; }
  out += "trailer\n<< /Size " + to_string(off.size() + 1) + " /Root 1 0 R >>\nstartxref\n" + to_string(xr) + "\n%%EOF\n";
  ofstream o(argv[2], ios::binary); o << out; return o ? 0 : 4;
}
