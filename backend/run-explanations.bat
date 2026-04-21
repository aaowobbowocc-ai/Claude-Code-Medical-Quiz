@echo off
cd /d "C:\Users\USER\Desktop\國考知識\醫師知識王\backend"
echo Starting at %date% %time% >> generate-explanations.log
node generate-all-explanations.js >> generate-explanations.log 2>&1
echo Finished at %date% %time% >> generate-explanations.log
schtasks /delete /tn "GenerateExamExplanations" /f >nul 2>&1
