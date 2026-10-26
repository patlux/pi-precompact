# Footer-Status in FigCraft

`footer-status.figcraft` zeigt, wie pi-precompact seinen Zustand im Pi-Footer meldet.
Die Datei enthält außerdem Vorschläge für die nächste Fassung.
Der Code ist die Quelle. Ändert sich dort etwas, wird die Datei nachgezogen, nicht umgekehrt.

## Inhalt

| Seite | Inhalt |
| --- | --- |
| 01 Stand heute | Sechs Zustände, Sonderfälle (ohne `(auto)`, 48 Spalten), Übergänge, Beobachtungen, Farben |
| 02 Verbesserungen | V1–V6, Empfehlung V1 + V4 + V5, Bewertung |
| 03 Kreative Ideen | K1–K7, Favorit K4 + K2 (später K1), Bewertung |
| 04 Einblenden | Leiste erst ab der ersten Antwort, Ablauf in 7 Bildern (240 ms), Zeitachse, Regeln, verworfene Varianten |
| 05 Prototyp Einblenden | Abspielbarer Flow „Einblenden“: acht Terminal-Bilder, zeitgesteuert verkettet |

## Quelle und Darstellung

- Seite 01 ist aus Pis echtem `FooterComponent` 1.4.0 gerendert, mit pi-precompact `de95728`
  und dem damaligen Status neben `(auto)`: 120 Spalten, Theme dark, Truecolor.
- Seiten 02 bis 05 sind Entwürfe nach denselben Ausrichtungs- und Farbregeln. Sie sind nicht gerendert.
- Die Entwürfe zeigen noch die frühere Kurzform `bg` (`bg: idle`, `bg compact: idle`). Das Plugin zeigt heute
  `pre` im Footer und `precompact: <state>` in Pis Statuszeile.
- Die Zwischenbilder auf 04 und 05 sind in OKLab berechnet, vom Terminal-Hintergrund #2C2E33 zur Zielfarbe.
  Kurve `cubic-bezier(0.23, 1, 0.32, 1)`, Welle 5 ms je Spalte und 120 ms je Zeichen, Füllung 80–240 ms.
  Das Plugin mischt in sRGB, weil `mixColors` in OKLCH Rot über Violett führt; der Unterschied ist kaum sichtbar.
- Zahlen sind Beispielwerte. Die Schwellen im Entwurf (82,4 % und 97,0 % bei 272k) rechnen mit 8192 Tokens Reserve.
  Pi 1.4.0 hebt die Reserve auf mindestens 20 % des Fensters an. Bei 272k startet das Plugin deshalb bei 68,0 %,
  und Pi kompaktiert bei 80,0 %, wie die echte Statuskarte in `docs/media/status-card.png` zeigt.
- Schrift: MesloLGS Nerd Font 14 px wie in der Ghostty-Konfiguration, 8,44 px pro Spalte, 18 px pro Zeile.
- Terminalfläche #2C2E33 (Ghostty Sonokai). Farben aus Pis Theme dark; die Legende steht auf Seite 01.
- Jede Terminalzeile ist ein Textlayer mit farbigen Bereichen.
- Gestrichelte Rahmen markieren den Bereich, den das Plugin einfügt oder ändert. Sie sind kein UI.
- Braille-Glyphen (K3) kommen aus einer Ersatzschrift und sind minimal breiter als eine Spalte.
- Die Entwürfe sind einfache Frames mit freien Werten, keine Komponenten oder Variablen.

## Arbeiten mit der Datei

Mit dem MCP-Server `figcraft` der FigCraft-App arbeiten.

1. `list_windows`. Kein Fenster nehmen, das eine andere Session benutzt.
2. `open_window` mit dem absoluten Pfad dieser `footer-status.figcraft`.
   Das fokussierte FigCraft-Fenster muss dafür sichtbar sein.
3. Neue Terminalzeilen spaltengenau bauen: ein Textlayer pro Zeile, Farben per `selection.setPaint` mit `range`.
4. Prüfen mit `outline`, `lint_layout` und `screenshot`. Speichern mit `save_file` und danach `file_status`
   → `savedAndCurrent: true`.
