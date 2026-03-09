/**
 * Target function for the format_date YAML binding.
 */

export function formatDateString(dateString: string, outputFormat: string): {
  formatted: string;
} {
  const dt = new Date(dateString);

  // Simple format substitution (subset of strftime)
  const formatted = outputFormat
    .replace('%Y', String(dt.getFullYear()))
    .replace('%m', String(dt.getMonth() + 1).padStart(2, '0'))
    .replace('%d', String(dt.getDate()).padStart(2, '0'))
    .replace(
      '%B',
      dt.toLocaleString('en-US', { month: 'long' }),
    );

  return { formatted };
}
