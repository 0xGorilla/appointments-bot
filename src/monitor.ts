// monitor.ts
import { chromium } from '@playwright/test';
import axios from 'axios';
import dotenv from 'dotenv';
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
    CURRENT_APPOINTMENT_DATE: z.string().transform(date => new Date(date)),
    CHECK_INTERVAL_MS: z.string().transform(ms => parseInt(ms)),
    OPSGENIE_API_KEY: z.string(),
});

const env = envSchema.parse(process.env);

interface OpsGenieAlert {
  id: string;
  status: string;
  message: string;
  createdAt: string;
}

interface OpsGenieResponse {
  data: OpsGenieAlert[];
}

function formatDateCET(date: Date): string {
  return date.toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace('.', '');
}

async function hasOpenAlerts(): Promise<boolean> {
  try {
    const response = await axios.get<OpsGenieResponse>(
      'https://api.opsgenie.com/v2/alerts?query=status%3Aopen',
      {
        headers: {
          'Authorization': `GenieKey ${env.OPSGENIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const openAlerts = response.data.data.filter(alert => alert.status !== 'closed');
    return openAlerts.length > 0;
  } catch (error) {
    console.error('❌ Failed to check OpsGenie alerts:', error);
    // If we can't check alerts, assume there are none to avoid getting stuck
    return false;
  }
}

async function sendOpsGenieAlert(earlierDate: Date) {
  try {
    await axios.post(
      'https://api.opsgenie.com/v2/alerts',
      {
        message: 'Earlier appointment available!',
        description: `Found appointment on ${formatDateCET(earlierDate)}. Current appointment: ${formatDateCET(env.CURRENT_APPOINTMENT_DATE)}`,
        tags: ['appointment-checker']
      },
      {
        headers: {
          'Authorization': `GenieKey ${env. OPSGENIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ OpsGenie alert sent successfully');
  } catch (error) {
    console.error('❌ Failed to send OpsGenie alert:', error);
  }
}

async function checkAppointment() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`🔍 Checking for appointments at ${formatDateCET(new Date())}`);
    
    await page.goto('https://ouder-amstel.mijnafspraakmaken.nl/client/');
    await page.getByText('Brondocumenten afhalen/inleveren').click();
    await page.getByText('Ga verder naar stap 2').click();

    const response = await page.waitForResponse(
      response => response.url().includes('/firstAvailableAppointmentTime') && 
                 response.status() === 200
    );
    
    const body = await response.json();
    const firstAvailableDate = new Date(body.data[0].firstAvailableTime);

    console.log('📅 First available date:', formatDateCET(firstAvailableDate));
    console.log('📅 Current appointment date:', formatDateCET(env.CURRENT_APPOINTMENT_DATE));

    if (firstAvailableDate.getTime() < env.CURRENT_APPOINTMENT_DATE.getTime()) {
      console.log('🎉 Found earlier appointment!');
      await sendOpsGenieAlert(firstAvailableDate);
    } else {
      console.log('😴 No earlier appointments available');
    }
  } catch (error) {
    console.error('❌ Error during check:', error);
    // Optionally send an alert about the check failing
    // await sendOpsGenieAlert(new Date(), 'Check failed');
  } finally {
    await browser.close();
  }
}

async function startMonitoring() {
  console.log('🚀 Starting appointment monitor');
  console.log(``);
  
  while (true) {
    const hasOpenAlertsNow = await hasOpenAlerts();
    if (hasOpenAlertsNow) {
      console.log('⚠️ Found open alerts, skipping check...');
    } else {
      await checkAppointment();
    }
    console.log(`⏰ Waiting ${env.CHECK_INTERVAL_MS / 1000} seconds until next check...`);
    console.log(``);
    await new Promise(resolve => setTimeout(resolve, env.CHECK_INTERVAL_MS));
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('👋 Shutting down...');
  process.exit(0);
});

startMonitoring().catch(console.error);