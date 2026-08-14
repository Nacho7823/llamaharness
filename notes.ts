import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Simple in-memory store for the notepad tools
const notes = new Map<string, string>();

export function registerNotesTools(server: McpServer): void {
  server.tool(
    'create_note',
    'Crea una nueva nota.',
    { name: z.string().describe('El nombre de la nota.'), content: z.string().describe('El contenido de la nota.') },
    async ({ name, content }) => {
      notes.set(name, content);
      return { content: [{ type: 'text', text: `Nota '${name}' creada con éxito.` }] };
    },
  );

  server.tool(
    'read_note',
    'Lee el contenido de una nota existente.',
    { name: z.string().describe('El nombre de la nota.') },
    async ({ name }) => {
      const content = notes.get(name);
      const text = content === undefined ? `Error: La nota '${name}' no existe.` : content;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool('list_notes', 'Lista los nombres de todas las notas guardadas.', {}, async () => {
    return { content: [{ type: 'text', text: JSON.stringify([...notes.keys()]) }] };
  });

  server.resource('notes://all', 'Todas las notas en formato JSON', async () => ({
    contents: [{ uri: 'notes://all', text: JSON.stringify(Object.fromEntries(notes), null, 2) }],
  }));
}