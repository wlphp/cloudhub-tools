/** Small, decorative platform glyphs; the server row provides the accessible label. */
export function HostPlatformIcon({ platform }: { platform: string }) {
  if (platform === "windows") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="#58B9FF" d="M2 4.5 10.5 3.3v8H2zm10-1.4L22 1.7v9.6H12zM2 12.8h8.5v8L2 19.6zm10 0h10v9.5L12 20.9z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#20242B" stroke="#9CA3AF" strokeWidth=".65" d="M12 2c-3.4 0-4.8 2.8-4.8 6.2 0 2.4-2.8 5-3 8.4-.1 2.7 2.9 4.1 7.8 4.1s7.9-1.4 7.8-4.1c-.2-3.4-3-6-3-8.4C16.8 4.8 15.4 2 12 2Z" />
      <path fill="#F5F6F8" d="M12 9.7c-3.1 0-4.8 3.3-4.8 6.5 0 2.8 1.8 4.1 4.8 4.1s4.8-1.3 4.8-4.1c0-3.2-1.7-6.5-4.8-6.5Z" />
      <ellipse cx="10" cy="7.5" rx="1.5" ry="2" fill="#FFF" />
      <ellipse cx="14" cy="7.5" rx="1.5" ry="2" fill="#FFF" />
      <ellipse cx="10.4" cy="7.8" rx=".65" ry="1" fill="#20242B" />
      <ellipse cx="13.6" cy="7.8" rx=".65" ry="1" fill="#20242B" />
      <path fill="#F4BC45" d="m8.6 10 3.4-1.7 3.4 1.7-3.4 2.1zM4 19.3l3.7-1.1 2.4 3.1-6.4.3zm16 0-3.7-1.1-2.4 3.1 6.4.3z" />
    </svg>
  );
}
