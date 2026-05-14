#!/usr/bin/env node
/**
 * scrape-ceec.js
 * 爬取大考中心（CEEC）學測/分科測驗選擇題
 *
 * Usage:
 *   node scripts/scrape-ceec.js --exam gsat --year 115
 *   node scripts/scrape-ceec.js --exam ast  --year 114
 *   node scripts/scrape-ceec.js --exam gsat          (all years)
 *   node scripts/scrape-ceec.js                      (all exams, all years)
 *   node scripts/scrape-ceec.js --dry-run            (print targets, no download)
 */

'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const pdfParse = require('pdf-parse');

const BASE    = 'https://www.ceec.edu.tw';
const OUT_DIR = path.join(__dirname, '..');   // backend/

// ─── URL Registry ────────────────��─────────────────────────────────────────
// Add new years here; scraper will pick them up automatically.
// subject_tag must match exam-config ui.tagNames key.
const REGISTRY = {
  gsat: {
    name: '學科能力測驗',
    outputFile: 'questions-gsat.json',
    subjects: [
      { tag: 'zh',     name: '國文'  },
      { tag: 'en',     name: '英文'  },
      { tag: 'social', name: '社會'  },
      { tag: 'science', name: '自然' },
    ],
    years: {
      '115': {
        zh:      { q: '/files/file_pool/1/0Q026474137060950753/01-115%E5%AD%B8%E6%B8%AC%E5%9C%8B%E7%B6%9C%E8%A9%A6%E5%8D%B7.pdf',                         a: '/files/file_pool/1/0Q020546019713546791/01-115%E5%AD%B8%E6%B8%AC%E5%9C%8B%E8%AA%9E%E6%96%87%E7%B6%9C%E5%90%88%E8%83%BD%E5%8A%9B%E6%B8%AC%E9%A9%97%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0q054532302653501476/02-115%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e8%a9%a6%e5%8d%b7.pdf',                         a: '/files/file_pool/1/0q040594609847120321/02-115%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e7%ad%94%e6%a1%88.pdf' },
        social:  { q: '/files/file_pool/1/0q054534130270752519/05-115%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e8%a9%a6%e5%8d%b7.pdf',                         a: '/files/file_pool/1/0q040582211712162219/05-115%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e7%ad%94%e6%a1%88.pdf' },
        science: { q: '/files/file_pool/1/0q054346117821958325/06-115%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e8%a9%a6%e5%8d%b7.pdf',                         a: '/files/file_pool/1/0q040579122726476606/06-115%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e7%ad%94%e6%a1%88.pdf' },
      },
      '114': {
        zh:      { q: '/files/file_pool/1/0P036403076668286531/114%E5%AD%B8%E6%B8%AC%E5%9C%8B%E7%B6%9C%E8%A9%A6%E9%A1%8C.pdf',                              a: '/files/file_pool/1/0P020599887773780175/114%E5%AD%B8%E6%B8%AC%E5%9C%8B%E8%AA%9E%E6%96%87%E7%B6%9C%E5%90%88%E8%83%BD%E5%8A%9B%E6%B8%AC%E9%A9%97%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0p056425554473267580/02-114%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e8%a9%a6%e9%a1%8c.pdf',                         a: '/files/file_pool/1/0p051545433631383724/02-114%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e7%ad%94%e6%a1%88.pdf' },
        social:  { q: '/files/file_pool/1/0p056429479567292230/05-114%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E9%A1%8C.pdf',                         a: '/files/file_pool/1/0P043432063382560936/05-114%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0p080497875174268441/114%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e8%a9%a6%e9%a1%8c%e5%ae%9a%e7%a8%bf.pdf',          a: '/files/file_pool/1/0P019609131102357003/114%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
      '113': {
        zh:      { q: '/files/file_pool/1/0O021577232828045024/01-113%E5%AD%B8%E6%B8%AC%E5%9C%8B%E7%B6%9C%E8%A9%A6%E9%A1%8C.pdf',                         a: '/files/file_pool/1/0O022617889719119864/01-113%E5%AD%B8%E6%B8%AC%E5%9C%8B%E8%AA%9E%E6%96%87%E7%B6%9C%E5%90%88%E8%83%BD%E5%8A%9B%E6%B8%AC%E9%A9%97%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0o051427482769341323/02-113%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%A7%91%E5%AE%9A%E7%A8%BF.pdf',                a: '/files/file_pool/1/0O023491996471637771/02-113%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0o051421699906768624/05-113%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%A7%91%E8%A9%A6%E9%A1%8C%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0O023592540079776812/05-113%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0o051419133380092609/06-113%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E9%A1%8C%E5%AE%9A%E7%A8%BF.pdf',         a: '/files/file_pool/1/0O037619670384057968/06-113%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E7%AD%94%E6%A1%88.pdf' },
      },
      '112': {
        zh:      { q: '/files/file_pool/1/0n045361284386617720/01-1-112%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87(%E5%9C%8B%E7%B6%9C)%E8%A9%A6%E5%8D%B7.pdf',  a: '/files/file_pool/1/0N015546576278192757/01-112%E5%AD%B8%E6%B8%AC%E5%9C%8B%E8%AA%9E%E6%96%87%E7%B6%9C%E5%90%88%E8%83%BD%E5%8A%9B%E6%B8%AC%E9%A9%97%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0n045359274947649605/02-112%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7.pdf',                         a: '/files/file_pool/1/0N015546416633213720/02-112%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0n045355860270752519/05-112%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7.pdf',                          a: '/files/file_pool/1/0N016537820294446149/05-112%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0n045354345199955411/06-112%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7.pdf',                          a: '/files/file_pool/1/0N015546235009344702/06-112%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
      '111': {
        zh:      { q: '/files/file_pool/1/0m053395009167828203/01-1-111%e5%ad%b8%e6%b8%ac%e5%9c%8b%e7%b6%9c%e8%a9%a6%e5%8d%b7.pdf',                       a: '/files/file_pool/1/0M023644640310599007/01-111%E5%AD%B8%E6%B8%AC%E5%9C%8B%E8%AA%9E%E6%96%87%E7%B6%9C%E5%90%88%E8%83%BD%E5%8A%9B%E6%B8%AC%E9%A9%97%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0m053357638065462325/02-111%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7.pdf',                         a: '/files/file_pool/1/0M023644450776620070/02-111%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0m053364108279287592/05-111%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7.pdf',                         a: '/files/file_pool/1/0M024591111345563819/05-111%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0m053364692537358519/06-111%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7.pdf',                         a: '/files/file_pool/1/0M022642869959956342/06-111%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
      '110': {
        zh:      { q: '/files/file_pool/1/0l069610597439395113/110%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E8%A9%A6%E5%8D%B7.pdf',                            a: '/files/file_pool/1/0L023548972976213284/01-110%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0l069608312283063557/110%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7%20.pdf',                         a: '/files/file_pool/1/0L023548973411182211/02-110%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0l069606123954085532/110%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7.pdf',                            a: '/files/file_pool/1/0L023548973055061239/04-110%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0l069603548708753986/110%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7.pdf',                            a: '/files/file_pool/1/0L024395878277719165/05-110%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
      '109': {
        zh:      { q: '/files/file_pool/1/0k050365403832359411/01-109%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87(%E9%81%B8%E6%93%87%E9%A1%8C)%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0k050365523476238449/01-109%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0k050359836694452838/02-109%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7-%E5%AE%9A%E7%A8%BF.pdf',      a: '/files/file_pool/1/0K018689241635770142/02-109%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0k050349970904242355/04-109%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%A7%91-%E5%AE%9A%E7%A8%BF.pdf',               a: '/files/file_pool/1/0K018689531270649160/04-109%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0K019627997366329983/05-109%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0K019474602653501476/05-109%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
      '108': {
        zh:      { q: '/files/file_pool/1/0j193641495705823071/01-108%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87(%E9%81%B8%E6%93%87%E9%A1%8C)%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0j193641495349792009/01-108%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j196548669826315609/01-108%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j196548660460294627/02-108%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j196566553498301883/01-108%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j196566783577158838/04-108%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0j196569337291350837/01-108%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j196569388835229864/05-108%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
      },
      '107': {
        zh:      { q: '/files/file_pool/1/0j076800993877603476/01-107%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E5%AE%9A%E7%A8%BF.pdf',                         a: '/files/file_pool/1/0j076800992698855421/01-107%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%28%E9%81%B8%E6%93%87%E9%A1%8C%29%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076574893317534748/02-107%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076574893773665710/02-107%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076469490990825428/04-107%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076469499356946491/04-107%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0j076536210924409058/05-107%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076536219745651004/05-107%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E7%AD%94%E6%A1%88.pdf' },
      },
      '106': {
        zh:      { q: '/files/file_pool/1/0j076799773246037936/01-106%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076799774880916963/01-106%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076574214786979208/02-106%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076574215321858235/02-106%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076466336276623429/04-106%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076466337710592447/04-106%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0j076534426200207059/05-106%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076534427844186077/05-106%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
      },
      '105': {
        zh:      { q: '/files/file_pool/1/0j076798915260451323/01-105%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E7%A7%91%E5%AE%9A%E7%A8%BF.pdf',                a: '/files/file_pool/1/0j076798915804320340/01-105%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076573375790393795/02-105%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%A7%91_%E5%AE%9A%E7%A8%BF.pdf',              a: '/files/file_pool/1/0j076573386334262722/02-105%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076464103106390358/04-105%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%A7%91_%E5%AE%9A%E7%A8%BF.pdf',              a: '/files/file_pool/1/0j076464103640279375/04-105%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0j076533104764853905/05-105%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E9%A1%8C%E5%AE%9A%E7%A8%BF.pdf',       a: '/files/file_pool/1/0j076533103120985978/05-105%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E7%AD%94%E6%A1%88.pdf' },
      },
      '104': {
        zh:      { q: '/files/file_pool/1/0j076798186273765810/01-104%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e5%ae%9a%e7%a8%bf.pdf',                        a: '/files/file_pool/1/0j076798186818644838/01-104%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076572827714606282/02-104%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E5%AE%9A%E7%A8%BF.pdf',                        a: '/files/file_pool/1/0j076572827358575210/02-104%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076460240926078376/04-104%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%A7%91%E5%AE%9A%E7%A8%BF.pdf',               a: '/files/file_pool/1/0j076460240560957303/04-104%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        // science A 尚未找到
      },
      '103': {
        zh:      { q: '/files/file_pool/1/0j076797377643100370/01-103%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E8%A9%A6%E9%A1%8C(%E5%AE%9A%E7%A8%BF).pdf',     a: '/files/file_pool/1/0j076797377821958325/01-103%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076572147183041652/02-103%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87-%E5%AE%9A%E7%A8%BF.pdf',                       a: '/files/file_pool/1/0j076572148362899607/02-103%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076456136302776377/04-103%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83-%E5%AE%9A%E7%A8%BF%E5%BE%8C%E4%BF%AE-v1.pdf' }, // A 尚未找到
        science: { q: '/files/file_pool/1/0j076528377326460907/05-103%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E8%A9%A6%E9%A1%8C(%E5%AE%9A%E7%A8%BF).pdf',     a: '/files/file_pool/1/0j076528378504218952/05-103%E5%AD%B8%E6%B8%AC%E8%87%AA%E7%84%B6%E9%81%B8%E6%93%87%E9%A1%8C%E7%AD%94%E6%A1%88.pdf' },
      },
      '102': {
        zh:      { q: '/files/file_pool/1/0j076796218291393795/01-102%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e5%ae%9a%e7%a8%bf.pdf',                        a: '/files/file_pool/1/0j076796219835272712/01-102%E5%AD%B8%E6%B8%AC%E5%9C%8B%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        en:      { q: '/files/file_pool/1/0j076571313825971626/02-102%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87(%E5%AE%9A%E7%A8%BF)%20.pdf',                  a: '/files/file_pool/1/0j076571314003729671/02-102%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0j076452783122453305/02-102%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e5%ae%9a%e7%a8%bf.pdf',                       a: '/files/file_pool/1/0j076452784300201350/04-102%E5%AD%B8%E6%B8%AC%E7%A4%BE%E6%9C%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0j076524764880916963/05-102%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e7%a7%91(%e5%ae%9a%e7%a8%bf).pdf',             a: '/files/file_pool/1/0j076524764424885980/05-102%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e7%ad%94%e6%a1%88.pdf' },
      },
      '101': {
        zh:      { q: '/files/file_pool/1/0j076795466755949741/01-101%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076795465577191796/01-101%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf0.pdf' },
        en:      { q: '/files/file_pool/1/0j076570671923496609/02-101%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf',     a: '/files/file_pool/1/0j076570670745648654/02-101%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E7%AD%94%E6%A1%88%E5%AE%9A%E7%A8%BF0.pdf' },
        social:  { q: '/files/file_pool/1/0j076450921220989289/04-101%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf%e5%be%8c%e4%bf%ae.pdf' }, // A 尚未找到
        science: { q: '/files/file_pool/1/0j076521891345563819/05-101%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076521890176715864/05-101%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf0.pdf' },
      },
      '100': {
        zh:      { q: '/files/file_pool/1/0j076794922031757742/01-100%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076794922675626779/100%e5%ad%b8%e6%b8%ac%e5%9c%8b%e6%96%87%e5%8f%83%e8%80%83%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf.pdf' },
        en:      { q: '/files/file_pool/1/0j076570267209194600/02-100%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076570278844073637/100%e5%ad%b8%e6%b8%ac%e8%8b%b1%e6%96%87%e5%8f%83%e8%80%83%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf.pdf' },
        social:  { q: '/files/file_pool/1/0j076449537506787280/04-100%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076449538141656207/100%e5%ad%b8%e6%b8%ac%e7%a4%be%e6%9c%83%e5%8f%83%e8%80%83%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf.pdf' },
        science: { q: '/files/file_pool/1/0j076520808630361810/05-100%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e8%a9%a6%e5%8d%b7%e5%ae%9a%e7%a8%bf.pdf',     a: '/files/file_pool/1/0j076520808175240837/100%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e5%8f%83%e8%80%83%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf.pdf' },
      },
      // CEEC 官方參考試卷（111 學年度起適用，非年度考試）
      // 著作權屬 CEEC，公開免費使用
      'ref': {
        zh:      { q: '/files/file_pool/1/0K097328714528444354/11-%E5%9C%8B%E7%B6%9C%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7%28%E5%8D%B7%E4%B8%80%29109.04.06%E6%9B%B4%E6%96%B0.pdf', a: '/files/file_pool/1/0K090329026224904029/13-%E5%9C%8B%E7%B6%9C%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7%28%E5%8D%B7%E4%B8%80%29%20%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88%E8%88%87%E8%A9%95%E5%88%86%E5%8E%9F%E5%89%87109.03.30%E6%9B%B4%E6%96%B0.pdf' },
        en:      { q: '/files/file_pool/1/0M263619256746092628/111%E5%AD%B8%E5%B9%B4%E5%BA%A6%E7%94%A8%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7.pdf', a: '/files/file_pool/1/0M263619887569719600/111%E5%AD%B8%E5%B9%B4%E5%BA%A6%E7%94%A8%E5%AD%B8%E6%B8%AC%E8%8B%B1%E6%96%87%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        social:  { q: '/files/file_pool/1/0K022540441422955985/01-%E7%A4%BE%E6%9C%83%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7.pdf', a: '/files/file_pool/1/0K022540452500703930/03-%E7%A4%BE%E6%9C%83%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        science: { q: '/files/file_pool/1/0K022533023261835915/01-%E8%87%AA%E7%84%B6%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7.pdf', a: '/files/file_pool/1/0K022533034449682960/03-%E8%87%AA%E7%84%B6%E8%80%83%E7%A7%91%E5%8F%83%E8%80%83%E8%A9%A6%E5%8D%B7%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
      },
    },
  },

  ast: {
    name: '分科測驗',
    outputFile: 'questions-ast.json',
    subjects: [
      { tag: 'history',   name: '歷史'      },
      { tag: 'geography', name: '地理'      },
      { tag: 'civics',    name: '公民與社會'  },
      { tag: 'physics',   name: '物理'      },
      { tag: 'chemistry', name: '化學'      },
      { tag: 'biology',   name: '生物'      },
    ],
    years: {
      '114': {
        history:   { q: '/files/file_pool/1/0p212553715888055904/02-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e6%ad%b7%e5%8f%b2%e8%a9%a6%e5%8d%b7.pdf',    a: '/files/file_pool/1/0p212555312517035418/02-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e6%ad%b7%e5%8f%b2%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        geography: { q: '/files/file_pool/1/0p212552479806157906/03-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%9c%b0%e7%90%86%e8%a9%a6%e5%8d%b7.pdf',    a: '/files/file_pool/1/0p212552881629874988/03-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%9c%b0%e7%90%86%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        civics:    { q: '/files/file_pool/1/0p212550944835350817/04-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%85%ac%e6%b0%91%e8%88%87%e7%a4%be%e6%9c%83%e8%a9%a6%e5%8d%b7.pdf', a: '/files/file_pool/1/0p212551515548087880/04-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%85%ac%e6%b0%91%e8%88%87%e7%a4%be%e6%9c%83%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        physics:   { q: '/files/file_pool/1/0p212549637497857819/05-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%89%a9%e7%90%86%e8%a9%a6%e5%8d%b7.pdf',    a: '/files/file_pool/1/0p217332507401284656/05-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%89%a9%e7%90%86%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        chemistry: { q: '/files/file_pool/1/0p212547955511545740/06-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%8c%96%e5%ad%b8%e8%a9%a6%e5%8d%b7.pdf',    a: '/files/file_pool/1/0p212548454142000280/06-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%8c%96%e5%ad%b8%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        biology:   { q: '/files/file_pool/1/0p212529015501164507/07-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%94%9f%e7%89%a9%e8%a9%a6%e5%8d%b7.pdf',    a: '/files/file_pool/1/0p212536022813515748/07-114%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%94%9f%e7%89%a9%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
      },
      '113': {
        history:   { q: '/files/file_pool/1/0o221358210534315264/113%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e6%ad%b7%e5%8f%b2%e8%a9%a6%e9%a1%8c.pdf',       a: '/files/file_pool/1/0o221358561357031236/02-113%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e6%ad%b7%e5%8f%b2%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        geography: { q: '/files/file_pool/1/0o221357152651032149/113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%9C%B0%E7%90%86%E8%A9%A6%E9%A1%8C.pdf',       a: '/files/file_pool/1/0O195688672889442836/03-113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%9C%B0%E7%90%86%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        civics:    { q: '/files/file_pool/1/0O195557499154970794/113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0O195688902423310863/04-113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        physics:   { q: '/files/file_pool/1/0o221353890776620070/113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%89%A9%E7%90%86%E8%A9%A6%E9%A1%8C.pdf',        a: '/files/file_pool/1/0o221354517405701583/05-113%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%89%a9%e7%90%86%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        chemistry: { q: '/files/file_pool/1/0o221352518254580513/113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%8C%96%E5%AD%B8%E8%A9%A6%E9%A1%8C.pdf',       a: '/files/file_pool/1/0O195604743537345169/06-113%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%8C%96%E5%AD%B8%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        biology:   { q: '/files/file_pool/1/0o221348105821976939/113%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%94%9f%e7%89%a9%e8%a9%a6%e9%a1%8c.pdf',       a: '/files/file_pool/1/0o221348436909723984/07-113%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%94%9f%e7%89%a9%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
      },
      '112': {
        history:   { q: '/files/file_pool/1/0n214404883899718778/02-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E6%AD%B7%E5%8F%B2%E8%80%83%E7%A7%91%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0N195584435465465775/02-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E6%AD%B7%E5%8F%B2%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        geography: { q: '/files/file_pool/1/0n214400568018507195/03-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%9C%B0%E7%90%86%E8%80%83%E7%A7%91%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0N195584595009344702/03-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%9C%B0%E7%90%86%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        civics:    { q: '/files/file_pool/1/0n214397186586477538/04-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0N195584746633213720/04-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        physics:   { q: '/files/file_pool/1/0n214393840237822585/05-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%89%A9%E7%90%86%E8%80%83%E7%A7%91%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0N195551207216582495/05-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%89%A9%E7%90%86%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        chemistry: { q: '/files/file_pool/1/0n214390396803217901/06-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%8C%96%E5%AD%B8%E8%80%83%E7%A7%91%E8%A9%A6%E9%A1%8C.pdf' }, // A 尚未找到
        biology:   { q: '/files/file_pool/1/0n214387178287976958/07-112%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%94%9F%E7%89%A9%E8%80%83%E7%A7%91%E8%A9%A6%E9%A1%8C.pdf', a: '/files/file_pool/1/0n214387749465724903/07-112%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%94%9f%e7%89%a9%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
      },
      '111': {
        history:   { q: '/files/file_pool/1/0m223580017832228468/02-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E6%AD%B7%E5%8F%B2%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0M194632172978782512/02-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E6%AD%B7%E5%8F%B2%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        geography: { q: '/files/file_pool/1/0m223502727452513865/03-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%9C%B0%E7%90%86%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0m223502566273765810/03-111%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e5%9c%b0%e7%90%86%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        civics:    { q: '/files/file_pool/1/0m223499786564352335/04-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0M194632493157530566/04-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%85%AC%E6%B0%91%E8%88%87%E7%A4%BE%E6%9C%83%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        physics:   { q: '/files/file_pool/1/0m223498466755949741/05-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%89%A9%E7%90%86%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0m223498335577191796/05-111%e5%88%86%e7%a7%91%e6%b8%ac%e9%a9%97%e7%89%a9%e7%90%86%e9%81%b8%e6%93%87%e9%a1%8c%e7%ad%94%e6%a1%88.pdf' },
        chemistry: { q: '/files/file_pool/1/0m223496479951425770/06-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%8C%96%E5%AD%B8%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf', a: '/files/file_pool/1/0M193675527527436604/06-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E5%8C%96%E5%AD%B8%E9%81%B8%E6%93%87%E9%A1%8C%E5%8F%83%E8%80%83%E7%AD%94%E6%A1%88.pdf' },
        biology:   { q: '/files/file_pool/1/0m223493108618143168/07-111%E5%88%86%E7%A7%91%E6%B8%AC%E9%A9%97%E7%94%9F%E7%89%A9%E8%A9%A6%E5%8D%B7%E5%AE%9A%E7%A8%BF.pdf' }, // A 尚未找到
      },
    },
  },
};

// ─── HTTP downloader ────────────────────────────────────────────────────────
function download(url) {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    const mod = fullUrl.startsWith('https') ? https : http;
    mod.get(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('redirect_no_location'));
        return download(loc.startsWith('http') ? loc : BASE + loc).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Answer PDF parser ─────────────────────────────────────────────────────
// Returns { "1": "D", "2": "A", ... }
// Answer PDFs use multi-column tables: "1 B  21 E  41 A" (3-4 pairs per line)
function parseAnswers(text) {
  const map = {};
  // Extract ALL "number answer" pairs from each line
  // Answer can be A-Z (single), ADE (multi-choice), ／ or / (non-selected)
  const pairRe = /(\d{1,2})\s+([A-Z]{1,5}|[／\/])/g;
  let m;
  while ((m = pairRe.exec(text)) !== null) {
    const num = m[1];
    const ans = m[2].replace('／', '/');
    // Sanity: num should be 1-70 range
    if (parseInt(num) >= 1 && parseInt(num) <= 70) {
      map[num] = ans;
    }
  }
  return map;
}

// ─── Question PDF parser ────────────────────────────────────────────────────
// Returns array of { num, question, options:{A,B,C,D} }
// Only questions with ALL of (A)(B)(C)(D) are returned.
function parseQuestions(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const blocks = [];   // [{ num, lines[] }]
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // New question: "1. text"  OR  "1." alone on line (text on next line)
    const m = line.match(/^(\d{1,2})[\.．]\s*(.*)$/);
    if (m) {
      const num = parseInt(m[1]);
      if (cur) blocks.push(cur);
      cur = { num, lines: [] };
      // If text is on same line, add it; otherwise next line will be added in the loop
      if (m[2].trim()) cur.lines.push(m[2].trim());
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) blocks.push(cur);

  const results = [];
  for (const block of blocks) {
    const raw = block.lines.join('\n');
    // Extract options (A)-(D).  Handle both:
    //   "(A) text (B) text (C) text (D) text"  (single line)
    //   "(A) text\n(B) text\n..."               (multi-line)
    const options = {};
    // Handle both "(A)" and "( A )" formats (CEEC PDFs are inconsistent)
    const optRe = /\(\s*([A-D])\s*\)\s*([\s\S]*?)(?=\s*\(\s*[A-D]\s*\)|$)/g;
    let m2;
    while ((m2 = optRe.exec(raw)) !== null) {
      const key = m2[1];
      // collapse whitespace in option text
      options[key] = m2[2].replace(/\s+/g, ' ').trim();
    }
    if (!options.A || !options.B || !options.C || !options.D) continue;

    // Question text = everything before the first (A) or ( A )
    const firstOpt = raw.search(/\(\s*[A-D]\s*\)/);
    const questionText = (firstOpt > 0 ? raw.slice(0, firstOpt) : raw)
      .replace(/\s+/g, ' ').trim();

    if (!questionText) continue;

    results.push({
      num: block.num,
      question: questionText,
      options,
    });
  }
  return results;
}

// ─── Build question objects ───────────────────────��──────────────────��──────
function buildQuestions({ examId, year, subjectTag, subjectName, parsedQs, answerMap }) {
  const results = [];
  for (const pq of parsedQs) {
    const ans = answerMap[String(pq.num)];
    // Single-choice only: answer must be exactly one letter A/B/C/D
    if (!ans || ans.length !== 1 || !'ABCD'.includes(ans)) continue;

    const id = `${examId}_${year}_${subjectTag}_${String(pq.num).padStart(3, '0')}`;
    results.push({
      id,
      roc_year: year,
      session: year === 'ref' ? '參考試卷' : '第一次',
      exam_code: `${examId}_${year}`,
      subject: subjectName,
      subject_tag: subjectTag,
      subject_name: subjectName,
      stage_id: 0,
      number: pq.num,
      question: pq.question,
      options: pq.options,
      answer: ans,
      explanation: '',
    });
  }
  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const examArg   = args.find(a => !a.startsWith('-'))  // e.g. "gsat"
    || (args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null);
  const yearArg   = args.indexOf('--year') >= 0 ? args[args.indexOf('--year') + 1] : null;

  const examKeys  = examArg ? [examArg] : Object.keys(REGISTRY);

  for (const examId of examKeys) {
    const examDef = REGISTRY[examId];
    if (!examDef) { console.error(`Unknown exam: ${examId}`); continue; }

    const yearKeys = yearArg ? [yearArg] : Object.keys(examDef.years);
    const outPath  = path.join(OUT_DIR, examDef.outputFile);

    // Load existing questions (merge, not overwrite)
    let existing = [];
    if (fs.existsSync(outPath)) {
      try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')).questions || []; } catch {}
    }
    const existingIds = new Set(existing.map(q => q.id));
    const newQuestions = [];

    for (const year of yearKeys) {
      const yearUrls = examDef.years[year];
      if (!yearUrls) { console.warn(`No URLs for ${examId} ${year}`); continue; }

      for (const subjectDef of examDef.subjects) {
        const tag = subjectDef.tag;
        const urls = yearUrls[tag];
        if (!urls || !urls.q || !urls.a) { console.warn(`  skip ${year} ${tag} (no URL)`); continue; }

        console.log(`\n📥 ${examId} ${year} ${subjectDef.name} ...`);
        if (dryRun) { console.log(`  Q: ${BASE}${urls.q}`); console.log(`  A: ${BASE}${urls.a}`); continue; }

        try {
          // Download + parse question PDF
          const qBuf  = await download(urls.q);
          const qData = await pdfParse(qBuf);
          const parsedQs = parseQuestions(qData.text);
          console.log(`  ${parsedQs.length} questions with (A)-(D) options parsed`);

          // Download + parse answer PDF
          const aBuf  = await download(urls.a);
          const aData = await pdfParse(aBuf);
          const ansMap = parseAnswers(aData.text);
          const singleChoice = Object.values(ansMap).filter(v => v.length === 1 && 'ABCD'.includes(v)).length;
          console.log(`  ${Object.keys(ansMap).length} answers parsed, ${singleChoice} single-choice`);

          // Build question objects
          const qs = buildQuestions({
            examId, year,
            subjectTag: tag,
            subjectName: subjectDef.name,
            parsedQs,
            answerMap: ansMap,
          });
          console.log(`  ✅ ${qs.length} single-choice questions built`);

          // Deduplicate
          for (const q of qs) {
            if (!existingIds.has(q.id)) {
              newQuestions.push(q);
              existingIds.add(q.id);
            }
          }
        } catch (e) {
          console.error(`  ❌ Error: ${e.message}`);
        }
      }
    }

    if (!dryRun && newQuestions.length > 0) {
      const all = [...existing, ...newQuestions];
      const output = { questions: all };
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
      console.log(`\n💾 Saved ${newQuestions.length} new questions → ${examDef.outputFile} (total: ${all.length})`);
    } else if (!dryRun) {
      console.log(`\nNo new questions to save for ${examId}.`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
