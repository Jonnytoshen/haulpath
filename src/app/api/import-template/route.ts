import ExcelJS from 'exceljs';
import { api } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  return api(async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '重途';
    const sheet = workbook.addWorksheet('点位', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [{ header: '名称', width: 30 }, { header: '经度', width: 22 }, { header: '纬度', width: 22 }];
    sheet.getRow(1).font = { bold: true };
    sheet.getCell('B1').note = '填写数值经度（-180 至 180），上传时声明 GCJ-02 或 WGS84 坐标系';
    sheet.getCell('C1').note = '填写数值纬度（-90 至 90），坐标系应与经度一致';
    return new Response(new Uint8Array(await workbook.xlsx.writeBuffer()), { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="haulpath-points-template.xlsx"; filename*=UTF-8''${encodeURIComponent('重途点位模板.xlsx')}`,
      'Cache-Control': 'no-store',
    } });
  });
}
