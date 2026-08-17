import { spawn } from 'child_process';

/**
 * Pings a server using system ping command
 */
export async function pingServer(host: string): Promise<any> {
  try {
    console.log('Pinging server:', host);

    // Use Windows ping command with proper parameters
    const pingCommand = `ping -n 3 -w 2000 ${host}`;

    return new Promise((resolve) => {
      const child = spawn('ping', ['-n', '3', '-w', '2000', host], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        console.log(`Ping command finished with code ${code} for ${host}`);
        console.log('Ping output:', stdout);

        if (code === 0 && stdout) {
          // Parse ping results - look for time values
          const timeMatches = stdout.match(/time[<=](\d+)ms/gi);
          if (timeMatches && timeMatches.length > 0) {
            const times = timeMatches.map(match => {
              const timeMatch = match.match(/(\d+)ms/);
              return timeMatch ? parseInt(timeMatch[1]) : 999;
            }).filter(time => time > 0 && time < 2000);

            if (times.length > 0) {
              const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
              console.log(`Successful ping for ${host}: ${avgTime}ms (from ${times.length} samples)`);
              resolve({
                success: true,
                ping: avgTime,
                samples: times.length,
                raw: stdout
              });
              return;
            }
          }

          // Check for "Destination host unreachable" or similar
          if (stdout.includes('Destination host unreachable') ||
              stdout.includes('Request timed out') ||
              stdout.includes('could not find host')) {
            console.log(`Host unreachable: ${host}`);
            resolve({
              success: false,
              ping: 999,
              error: 'Host unreachable',
              raw: stdout
            });
            return;
          }
        }

        // Default fallback for any other case
        console.log(`Ping failed for ${host}, using fallback`);
        resolve({
          success: false,
          ping: 999,
          error: stderr || 'Ping failed',
          raw: stdout
        });
      });

      child.on('error', (error) => {
        console.error(`Ping process error for ${host}:`, error);
        resolve({
          success: false,
          ping: 999,
          error: error.message
        });
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        console.log(`Ping timeout for ${host}`);
        child.kill();
        resolve({
          success: false,
          ping: 999,
          error: 'Ping timeout'
        });
      }, 10000);
    });
  } catch (error) {
    console.error('Ping error:', error);
    return {
      success: false,
      ping: 999,
      error: (error as Error).message
    };
  }
}
