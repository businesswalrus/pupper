import { Router, Request, Response } from 'express';
import { costTracker } from '@services/costTracker';
import { logger } from '@utils/logger';

const router = Router();

/**
 * Get real-time cost metrics
 */
router.get('/realtime', async (req: Request, res: Response) => {
  try {
    const costs = await costTracker.getRealtimeCosts();
    res.json({
      success: true,
      data: costs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get realtime costs', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve cost data',
    });
  }
});

/**
 * Generate cost report
 */
router.get('/report/:period', async (req: Request, res: Response) => {
  try {
    const period = req.params.period as 'hourly' | 'daily' | 'weekly' | 'monthly';
    const validPeriods = ['hourly', 'daily', 'weekly', 'monthly'];
    
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid period. Must be: hourly, daily, weekly, or monthly',
      });
    }

    const date = req.query.date ? new Date(req.query.date as string) : undefined;
    const report = await costTracker.generateCostReport(period, date);

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    logger.error('Failed to generate cost report', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to generate report',
    });
  }
});

/**
 * Set user budget
 */
router.post('/budget/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit, period } = req.body;

    if (!limit || typeof limit !== 'number' || limit <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid limit. Must be a positive number',
      });
    }

    if (!['daily', 'monthly'].includes(period)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid period. Must be: daily or monthly',
      });
    }

    await costTracker.setUserBudget(userId, limit, period);

    res.json({
      success: true,
      message: `Budget set for user ${userId}`,
      data: { userId, limit, period },
    });
  } catch (error) {
    logger.error('Failed to set user budget', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to set budget',
    });
  }
});

/**
 * Get cost breakdown by service
 */
router.get('/breakdown/service', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    
    // Custom query for service breakdown
    const { pool } = await import('@db/connection');
    const query = `
      SELECT 
        service,
        COUNT(*) as request_count,
        SUM(cost) as total_cost,
        AVG(cost) as avg_cost_per_request,
        SUM(quantity) as total_quantity,
        MAX(cost) as max_cost,
        MIN(cost) as min_cost
      FROM usage_metrics
      WHERE timestamp > NOW() - INTERVAL '%s days'
      GROUP BY service
      ORDER BY total_cost DESC
    `;

    const result = await pool.query(query.replace('%s', days.toString()));
    
    res.json({
      success: true,
      data: {
        period: `Last ${days} days`,
        services: result.rows,
        totalCost: result.rows.reduce((sum, row) => sum + parseFloat(row.total_cost), 0),
      },
    });
  } catch (error) {
    logger.error('Failed to get service breakdown', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to get breakdown',
    });
  }
});

/**
 * Get cost breakdown by user
 */
router.get('/breakdown/user', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const limit = parseInt(req.query.limit as string) || 20;
    
    const { pool } = await import('@db/connection');
    const query = `
      SELECT 
        user_id,
        COUNT(*) as request_count,
        SUM(cost) as total_cost,
        AVG(cost) as avg_cost_per_request,
        array_agg(DISTINCT service) as services_used
      FROM usage_metrics
      WHERE user_id IS NOT NULL
        AND timestamp > NOW() - INTERVAL '%s days'
      GROUP BY user_id
      ORDER BY total_cost DESC
      LIMIT %s
    `;

    const result = await pool.query(
      query.replace('%s', days.toString()).replace('%s', limit.toString())
    );
    
    res.json({
      success: true,
      data: {
        period: `Last ${days} days`,
        users: result.rows,
        totalUsers: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Failed to get user breakdown', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to get breakdown',
    });
  }
});

/**
 * Get cost trends
 */
router.get('/trends', async (req: Request, res: Response) => {
  try {
    const { pool } = await import('@db/connection');
    const period = req.query.period || '7 days';
    
    const query = `SELECT * FROM get_cost_trends($1::interval)`;
    const result = await pool.query(query, [period]);
    
    res.json({
      success: true,
      data: result.rows[0] || {},
    });
  } catch (error) {
    logger.error('Failed to get cost trends', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to get trends',
    });
  }
});

/**
 * Export cost data as CSV
 */
router.get('/export/csv', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = req.query.end || new Date();
    
    const { pool } = await import('@db/connection');
    const query = `
      SELECT 
        timestamp,
        service,
        operation,
        user_id,
        quantity,
        unit,
        cost,
        metadata
      FROM usage_metrics
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY timestamp DESC
    `;

    const result = await pool.query(query, [startDate, endDate]);
    
    // Convert to CSV
    const headers = ['Timestamp', 'Service', 'Operation', 'User ID', 'Quantity', 'Unit', 'Cost', 'Metadata'];
    const rows = result.rows.map(row => [
      row.timestamp.toISOString(),
      row.service,
      row.operation,
      row.user_id || '',
      row.quantity,
      row.unit,
      row.cost,
      JSON.stringify(row.metadata || {}),
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=cost-export-${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    logger.error('Failed to export cost data', { error: error as Error });
    res.status(500).json({
      success: false,
      error: 'Failed to export data',
    });
  }
});

export default router;