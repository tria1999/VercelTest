// app/api/create-zip/route.js
import JSZip from 'jszip';
import { Agent } from 'undici';
import { NextResponse } from 'next/server';

// Create a reusable agent with SSL disabled
const baseAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

// Session cache to avoid logging in for every request
let sessionCookies = null;
let sessionExpiry = null;

// Utility function to add delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Validate if response is a PDF
function isPDF(buffer) {
  // Check for PDF signature at the beginning
  const pdfSignature = Buffer.from('%PDF', 'utf-8');
  if (buffer.length < 4) return false;
  
  return buffer.slice(0, 4).equals(pdfSignature);
}

async function login() {
  const baseUrl = process.env.LUCEE_URL || 'https://hotel.webhotelier.localhost';
  const username = process.env.PDF_USERNAME || '';
  const password = process.env.PDF_PASSWORD || '';
  const companyCode = process.env.PDF_COMPANY_CODE || '';

  console.log(`Logging in as ${username} to ${baseUrl}...`);

  const loginResponse = await fetch(`${baseUrl}/login/login`, {
    method: 'POST',
    dispatcher: baseAgent,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      cmp_code: companyCode,
      username: username,
      password: password,
      remember_me: 'on'
    }),
    redirect: 'manual' // Don't follow redirects, we need the cookies
  });

  // Extract cookies from the response
  const cookies = loginResponse.headers.getSetCookie();
  console.log(`Login response status: ${loginResponse.status}`);
  console.log(`Received ${cookies.length} cookies`);

  if (cookies.length === 0) {
    throw new Error('Login failed - no cookies received');
  }

  // Store cookies as a string for subsequent requests
  sessionCookies = cookies.map(c => c.split(';')[0]).join('; ');
  sessionExpiry = Date.now() + (30 * 60 * 1000); // 30 minutes

  console.log('Login successful!');
  return sessionCookies;
}

async function getSessionCookies() {
  // Check if we have valid cached session
  if (sessionCookies && sessionExpiry && Date.now() < sessionExpiry) {
    return sessionCookies;
  }
  
  // Login to get new session
  return await login();
}

async function generatePdfForReservation(htlCode, resId, maxRetries = 3) {
  const baseUrl = process.env.LUCEE_URL || 'https://hotel.webhotelier.localhost';
  const pdfUrl = `${baseUrl}/res/print.cfm?htl_code=${htlCode}&res_id=${resId}&download`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Max 5 seconds
        console.log(`Retry attempt ${attempt}/${maxRetries} for ${htlCode}-${resId} after ${backoffDelay}ms...`);
        await delay(backoffDelay);
      }
      
      // Get session cookies (will login if needed)
      const cookies = await getSessionCookies();
      
      const response = await fetch(pdfUrl, {
        dispatcher: baseAgent,
        headers: {
          'Cookie': cookies
        },
        redirect: 'manual'
      });

      // Check if we got redirected to login (session expired)
      if (response.status === 302) {
        const location = response.headers.get('location');
        if (location && location.includes('forward=')) {
          console.log('Session expired, re-logging in...');
          sessionCookies = null;
          const newCookies = await getSessionCookies();
          
          // Retry the request with new cookies
          const retryResponse = await fetch(pdfUrl, {
            dispatcher: baseAgent,
            headers: {
              'Cookie': newCookies
            }
          });
          
          if (!retryResponse.ok) {
            throw new Error(`HTTP ${retryResponse.status}: ${retryResponse.statusText}`);
          }
          
          const arrayBuffer = await retryResponse.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          
          // Validate that it's actually a PDF
          if (!isPDF(buffer)) {
            throw new Error(`Response is not a valid PDF (likely HTML error page)`);
          }
          
          console.log(`Successfully fetched PDF for ${htlCode}-${resId}, size: ${buffer.byteLength} bytes`);
          return buffer;
        }
      }
      
      if (!response.ok && response.status !== 302) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Validate that it's actually a PDF
      if (!isPDF(buffer)) {
        throw new Error(`Response is not a valid PDF (likely HTML error page)`);
      }
      
      console.log(`Successfully fetched PDF for ${htlCode}-${resId}, size: ${buffer.byteLength} bytes`);
      return buffer;
      
    } catch (err) {
      console.error(`Attempt ${attempt}/${maxRetries} failed for ${htlCode}-${resId}:`, err.message);
      
      if (attempt === maxRetries) {
        throw new Error(`Failed after ${maxRetries} attempts: ${err.message}`);
      }
      // Continue to next retry attempt
    }
  }
}

// OPTIONS handler for CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// POST handler - main entry point
export async function POST(req) {
  try {
    const { reservationIds } = await req.json();

    if (!reservationIds || !Array.isArray(reservationIds)) {
      return NextResponse.json(
        { error: 'Invalid or missing reservationIds' },
        { status: 400 }
      );
    }

    // Validate and extract `htl_code` and `res_id` values
    let reservations;
    try {
      reservations = reservationIds.map((item) => {
        if (!item.htl_code || !item.res_id) {
          throw new Error('Invalid reservation object structure');
        }
        return { htl_code: item.htl_code, res_id: item.res_id };
      });
    } catch (validationErr) {
      console.error('Validation error:', validationErr);
      return NextResponse.json(
        { error: validationErr.message },
        { status: 400 }
      );
    }

    console.log(`Processing ${reservations.length} reservations...`);
    const pdfResults = [];
    
    // Process in batches of 20 concurrent requests with delays between batches
    const batchSize = 20;
    for (let i = 0; i < reservations.length; i += batchSize) {
      const batch = reservations.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} reservations)...`);
      
      const batchPromises = batch.map(async ({ htl_code, res_id }, index) => {
        const batchIndex = i + index + 1;
        console.log(`Generating PDF for reservation ${res_id} (hotel: ${htl_code}) [${batchIndex}/${reservations.length}]...`);
        
        try {
          const pdfBlob = await generatePdfForReservation(htl_code, res_id);
          return {
            htl_code,
            res_id,
            filename: `${htl_code}-${res_id}.pdf`,
            blob: pdfBlob
          };
        } catch (err) {
          console.error(`Failed to fetch PDF for ${htl_code}-${res_id} after all retries:`, err.message);
          return null; // Mark as failed
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      pdfResults.push(...batchResults.filter(result => result !== null));
      
      // Add delay between batches to avoid overwhelming the server
      if (i + batchSize < reservations.length) {
        await delay(200);
      }
    }

    // Log summary
    const successCount = pdfResults.length;
    const failCount = reservations.length - successCount;
    console.log(`\nProcessing complete: ${successCount} succeeded, ${failCount} failed out of ${reservations.length} total`);
    
    if (pdfResults.length === 0) {
      return NextResponse.json(
        { error: 'Failed to fetch any PDFs' },
        { status: 500 }
      );
    }

    const zip = new JSZip();
    for (const result of pdfResults) {
      zip.file(result.filename, result.blob);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename=reservations.zip',
        'Access-Control-Allow-Origin': '*',
        'X-PDF-Success-Count': successCount.toString(),
        'X-PDF-Fail-Count': failCount.toString(),
      },
    });

  } catch (err) {
    console.error('Error in create-zip:', err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
