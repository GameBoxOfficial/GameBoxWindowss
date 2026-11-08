ساخت GameBox.exe:

روش ۱ (بدون نصب چیزی):
 1. یک ریپازیتوری خصوصی در github.com بسازید و محتوای همین پوشه را آپلود کنید (پوشه .github هم باشد).
 2. تب Actions > "Build Windows EXE" > Run workflow.
 3. بعد از چند دقیقه GameBox-exe را دانلود کنید؛ داخلش GameBox.exe است (نسخه Portable، بدون نصب).

روش ۲ (روی ویندوز، با Node.js):
   npm install
   npm start        (اجرای مستقیم)
   npm run build    (ساخت exe در پوشه dist)

کلید F11 = تمام‌صفحه. برای تغییر بازی فایل index.html را عوض کنید.
