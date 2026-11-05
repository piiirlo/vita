import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { format as formatSql } from "sql-formatter";
import type { DbType } from "../api.ts";
import { SQL_EDITOR_OPTIONS, SQL_LANGUAGE, registerSqlCompletion } from "./monacoSetup.ts";
import { editorErrorPosition, type RunOffset } from "./results.ts";

type MonacoEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

export type RunTarget = RunOffset & { sql: string };

export type EditorError = {
  message: string;
  line: number | null;
  column: number | null;
  offset: RunOffset;
};

export type SqlEditorHandle = {
  /** The selection if there is one, else the whole text. */
  getRunTarget(): RunTarget | null;
  insertText(text: string): void;
  /** Format the selection (or everything). Returns an error message, or null. */
  format(dbType: DbType): string | null;
  disposeModel(path: string): void;
  focus(): void;
};

type Props = {
  ref?: Ref<SqlEditorHandle>;
  /** One Monaco model per tab (keeps undo history per tab). */
  path: string;
  defaultValue: string;
  onChange(value: string): void;
  onRun(): void;
  error: EditorError | null;
};

const MARKER_OWNER = "vita";

export default function SqlEditor({ ref, path, defaultValue, onChange, onRun, error }: Props) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // Autocomplete for this editor; removed again when the editor unmounts.
  useEffect(() => {
    const completion = registerSqlCompletion();
    return () => completion.dispose();
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.addAction({
      id: "vita.run",
      label: "Run query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current(),
    });
    // Editing clears the error underline.
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    });
    editor.focus();
  };

  // Underline the error position.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    const position = error ? editorErrorPosition(error, error.offset) : null;
    if (!error || !position || position.line > model.getLineCount()) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const { line } = position;
    let startColumn = 1;
    let endColumn = model.getLineMaxColumn(line);
    if (position.column !== null) {
      startColumn = Math.min(position.column, model.getLineMaxColumn(line));
      const word = model.getWordAtPosition({ lineNumber: line, column: startColumn });
      endColumn = word ? Math.max(word.endColumn, startColumn + 1) : startColumn + 1;
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: line,
        endLineNumber: line,
        startColumn,
        endColumn,
      },
    ]);
    editor.revealLineInCenterIfOutsideViewport(line);
  }, [error, path]);

  useImperativeHandle(ref, () => ({
    getRunTarget() {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return null;
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        return {
          sql: model.getValueInRange(selection),
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
        };
      }
      return { sql: model.getValue(), startLine: 1, startColumn: 1 };
    },
    insertText(text: string) {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      if (!editor || !selection) return;
      editor.executeEdits("vita-insert", [{ range: selection, text, forceMoveMarkers: true }]);
      editor.focus();
    },
    format(dbType: DbType) {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return null;
      const selection = editor.getSelection();
      const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange();
      try {
        const formatted = formatSql(model.getValueInRange(range), {
          language: dbType === "mysql" ? "mysql" : "postgresql",
          keywordCase: "upper",
          tabWidth: 2,
        });
        editor.executeEdits("vita-format", [{ range, text: formatted }]);
        editor.focus();
        return null;
      } catch (err) {
        return `Couldn't format this SQL: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      }
    },
    disposeModel(modelPath: string) {
      const monaco = monacoRef.current;
      monaco?.editor.getModel(monaco.Uri.parse(modelPath))?.dispose();
    },
    focus() {
      editorRef.current?.focus();
    },
  }));

  return (
    <Editor
      path={path}
      defaultValue={defaultValue}
      language={SQL_LANGUAGE}
      onChange={(value) => onChange(value ?? "")}
      onMount={handleMount}
      options={SQL_EDITOR_OPTIONS}
    />
  );
}
