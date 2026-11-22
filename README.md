# Generator sprawdzianów 📝

Aplikacja dla rodziców i nauczycieli. Robisz telefonem zdjęcia stron podręcznika, a program układa z nich **kartkówkę lub sprawdzian** z kluczem odpowiedzi.

- **Rodzaje zadań:** otwarte, zamknięte ABC, prawda/fałsz, dopasowania i luki w zdaniach, w dowolnym miksie.
- **Grafiki ze stron:** ilustracje z podręcznika trafiają do zadań bez podpisów, żeby nie zdradzały odpowiedzi.
- **Klucz odpowiedzi chroniony hasłem rodzica:** dziecko nie podejrzy rozwiązań.
- **Podsumowanie na końcu sprawdzianu:** tabela punktów, skala ocen i miejsce na podpis rodzica.
- **Poprawki:** każde zadanie można edytować albo podmienić na nowe.
- **Druk i PDF:** sprawdzian i klucz drukują się osobno.

Program działa w systemie Windows, a cały interfejs jest po polsku.

## Instalacja

1. Pobierz plik `Generator-sprawdzianow-Setup-….exe` z zakładki **[Releases](../../releases)**.
2. Uruchom go i zainstaluj.
   - Windows może ostrzec, że aplikacja pochodzi od nieznanego wydawcy, bo instalator nie jest podpisany certyfikatem. Kliknij wtedy „Więcej informacji” → „Uruchom mimo to”.
3. Przy pierwszym uruchomieniu wybierz **silnik AI** (patrz niżej).

## Silnik AI: co wybrać?

Strony czyta i zadania układa model AI. Do wyboru masz cztery silniki:

| Silnik | Koszt | Czego potrzebujesz | Szybkość |
|---|---|---|---|
| **Google Gemini** | **darmowy** | konto Google i bezpłatny klucz z [Google AI Studio](https://aistudio.google.com/apikey) | strona ok. 20 s, sprawdzian ok. 20–40 s |
| **Claude** (Sonnet / Opus) | subskrypcja Claude Pro lub Max | zainstalowany i zalogowany [Claude Code](https://claude.com/product/claude-code) | strona ok. 20 s, sprawdzian ok. 20 s |
| **Codex** (ChatGPT) | płatna subskrypcja ChatGPT | zainstalowany i zalogowany [Codex](https://developers.openai.com/codex) | strona ok. 30 s, sprawdzian ok. 45 s |
| **Model lokalny** | **darmowy, offline** | program [Ollama](https://ollama.com/download) i ok. 3,3 GB na model | z kartą graficzną szybki; na zwykłym laptopie ok. 12 min na stronę |

- **Nie masz płatnej subskrypcji?** Wybierz **Google Gemini**: wystarczy darmowy klucz.
  - W programie: Narzędzia → Silnik AI → wklej klucz → „Zapisz klucz”.
  - Darmowy poziom Gemini ma dzienny limit zapytań. Zwykle wystarcza na kilka sprawdzianów dziennie.
  - W darmowym poziomie Google może wykorzystywać przesłane treści do ulepszania swoich usług.
- **Bezpłatne plany Claude i ChatGPT nie wystarczą.** Claude Code wymaga planu Pro lub wyższego. Codex w trybie używanym przez program wymaga płatnego planu ChatGPT.
- **Model lokalny** działa całkowicie bez internetu, ale na komputerze bez karty graficznej jest bardzo wolny.

Program sam wykrywa zainstalowane Claude Code, Codex i Ollamę. Klucz Gemini jest zapisywany na Twoim komputerze w postaci zaszyfrowanej.

## Jak używać

1. **Materiał** (Ctrl+M): dodaj zdjęcia stron albo cały folder.
   - AI czyta strony w tle. Przeczytane strony są zapamiętywane, więc następnym razem są gotowe od razu.
   - Kliknięciem zaznacz strony, z których ma być sprawdzian.
2. **Ustawienia** (Ctrl+,):
   - rodzaj: kartkówka albo sprawdzian,
   - poziom trudności,
   - rodzaje zadań,
   - liczba zadań,
   - grafiki,
   - klasa i przedmiot.
3. **Generuj** (Ctrl+G).
4. **Popraw:**
   - Kliknij w tekst, aby go zmienić.
   - Po najechaniu na zadanie możesz kliknąć **🔄 Inne**, zmienić punkty albo przesunąć zadanie.
   - Grafikę można przykadrować.
5. **Rozwiąż** (Ctrl+3): uczeń rozwiązuje sprawdzian na komputerze.
   - Klika odpowiedzi ABC oraz P/F, wybiera litery w dopasowaniach, wpisuje wyrazy w luki i odpowiedzi na pytania otwarte.
   - Po kliknięciu „Zakończ i sprawdź” zadania zamknięte są oceniane automatycznie (✓/✗).
   - Rodzic po podaniu hasła widzi poprawne odpowiedzi, przyznaje punkty za pytania otwarte i dostaje wynik z oceną.
6. **🔒 Klucz** (Ctrl+2): przy pierwszym otwarciu ustawiasz hasło rodzica.
7. **Drukuj albo PDF** (Ctrl+P, Ctrl+E).

**Dobre zdjęcia:** jedna strona na zdjęcie, prosto z góry, przy dobrym świetle i bez cienia dłoni. Zdjęcia HEIC z iPhone'a trzeba zapisać jako JPG.

## Prywatność

- Zdjęcia stron są wysyłane tylko do wybranego silnika AI. Wyjątek to model lokalny, przy którym nic nie opuszcza komputera.
- Program nie ma własnego serwera i nie zbiera żadnych danych.
- Klucz odpowiedzi, hasło (zapisane jako skrót, nie wprost), ustawienia i biblioteka stron są zapisywane lokalnie w `%APPDATA%\Generator sprawdzianów`.

## Dla programistów

Wymagany jest [Node.js](https://nodejs.org) 20 lub nowszy.

```bash
npm install
npm start          # uruchomienie
npm run dist       # instalator Windows w katalogu dist/
```

W Windows możesz też kliknąć dwukrotnie `Uruchom.bat`, który przy pierwszym uruchomieniu sam zainstaluje zależności.

| Plik | Rola |
|---|---|
| `src/main.js` | okno, menu, wybór silnika, biblioteka stron (kolejka w tle + pamięć), hasło rodzica, PDF, pliki |
| `src/engines/claude.js` | Claude Code w trybie bezgłowym (`claude -p --json-schema`) |
| `src/engines/codex.js` | Codex CLI (`codex exec --output-schema`) |
| `src/engines/gemini.js` | Gemini API (`generateContent`, odpowiedź JSON wg schematu, automatyczny wybór dostępnego modelu) |
| `src/engines/ollama.js` | model lokalny przez Ollamę |
| `src/engines/common.js` | wspólny schemat zadań i polecenie dla AI |
| `src/ocr.js` | Tesseract (polski) – odcinanie podpisów z wycinków grafik |
| `src/renderer/` | interfejs (`index.html`, `styles.css`, `app.js`) |

## Licencja

[GPL-3.0](LICENSE). Możesz używać, zmieniać i rozpowszechniać program, ale zmienione wersje też muszą pozostać otwarte.
