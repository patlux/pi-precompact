# Footer-Status in FigCraft

`footer-status.figcraft` zeigt, wie pi-background-compaction seinen Zustand im Pi-Footer meldet.
Die Datei enthält außerdem Vorschläge für die nächste Fassung.
Der Code ist die Quelle. Ändert sich dort etwas, wird die Datei nachgezogen, nicht umgekehrt.

## Inhalt

| Seite | Inhalt |
| --- | --- |
| 01 Stand heute | Sechs Zustände, Sonderfälle (ohne `(auto)`, 48 Spalten), Übergänge, Beobachtungen, Farben |
| 02 Verbesserungen | V1–V6, Empfehlung V1 + V4 + V5, Bewertung |
| 03 Kreative Ideen | K1–K7, Favorit K4 + K2 (später K1), Bewertung |

## Quelle und Darstellung

- Seite 01 ist aus Pis echtem `FooterComponent` 1.4.0 gerendert, mit pi-session-id-footer `239aa7d`
  und pi-background-compaction `de95728`: 120 Spalten, Theme dark, Truecolor.
- Seiten 02 und 03 sind Entwürfe nach denselben Ausrichtungs- und Farbregeln. Sie sind nicht gerendert.
- Zahlen sind Beispielwerte. Die Schwellen folgen den Defaults: Start bei 85 % von Kontextfenster
  minus Reserve (82,4 % bei 272k und 8192 Reserve), Pis Schwelle bei 97,0 %.
- Schrift: MesloLGS Nerd Font 14 px wie in der Ghostty-Konfiguration, 8,44 px pro Spalte, 18 px pro Zeile.
- Terminalfläche #2C2E33 (Ghostty Sonokai). Farben aus Pis Theme dark; die Legende steht auf Seite 01.
- Jede Terminalzeile ist ein Textlayer mit farbigen Bereichen.
- Gestrichelte Rahmen markieren den Bereich, den das Plugin einfügt oder ändert. Sie sind kein UI.
- Braille-Glyphen (K3) kommen aus einer Ersatzschrift und sind minimal breiter als eine Spalte.
- Die Entwürfe sind einfache Frames mit freien Werten, keine Komponenten oder Variablen.

## Arbeiten mit der Datei

Vorher `/Users/patwoz/dev/agents/skills/figcraft/SKILL.md` lesen und den MCP-Server `figcraft` benutzen.

1. `list_windows`. Kein Fenster nehmen, das eine andere Session benutzt.
2. `open_window {path: "/Users/patwoz/dev/Personal/pi/pi-background-compaction/design/figcraft/footer-status.figcraft"}`.
   Das fokussierte FigCraft-Fenster muss dafür sichtbar sein.
3. Neue Terminalzeilen spaltengenau bauen: ein Textlayer pro Zeile, Farben per `selection.setPaint` mit `range`.
4. Prüfen mit `outline`, `lint_layout` und `screenshot`. Speichern mit `save_file` und danach `file_status`
   → `savedAndCurrent: true`.
