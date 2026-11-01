package com.cruisedeals.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Periodic background price check (scheduled from Alerts.schedule). */
public class AlertJobService extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Alerts.checkAll(getApplicationContext());
                } finally {
                    jobFinished(params, false);
                }
            }
        }, "price-check").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // retry later
    }
}
