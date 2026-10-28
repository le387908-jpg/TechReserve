/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cn } from '../lib/utils';

export function Logo({ 
  className, 
  hideText = false, 
  variant = 'light' 
}: { 
  className?: string, 
  hideText?: boolean,
  variant?: 'light' | 'dark'
}) {
  const isDark = variant === 'dark';

  return (
    <div className={cn("flex items-center gap-3 shrink-0", className)}>
      <div className="relative flex items-center justify-center shrink-0">
        <svg 
          viewBox="0 0 100 100" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg" 
          className="h-10 w-10 md:h-12 md:w-12 shrink-0"
        >
          {/* Arch/Door */}
          <path 
            d="M20 90V40C20 23.4315 33.4315 10 50 10C66.5685 10 80 23.4315 80 40V90" 
            stroke={isDark ? "#8B0000" : "black"} 
            strokeWidth="12" 
            strokeLinecap="round" 
          />
          <path 
            d="M20 90H80" 
            stroke={isDark ? "#8B0000" : "black"} 
            strokeWidth="4" 
          />
          {/* Door Handle */}
          <circle cx="35" cy="55" r="4" fill={isDark ? "white" : "#8B0000"} />
          
          {/* Lightbulb/Icon element simplified */}
          <g transform="translate(65, 15) scale(0.6)">
            <path d="M15 5C10 5 6 9 6 14C6 17 8 19 10 21V25H20V21C22 19 24 17 24 14C24 9 20 5 15 5Z" stroke={isDark ? "white" : "#8B0000"} strokeWidth="2" />
            <path d="M10 28H20" stroke={isDark ? "white" : "#8B0000"} strokeWidth="2" />
          </g>
        </svg>
      </div>
      {!hideText && (
        <div className="flex flex-col leading-tight">
          <div className="flex items-baseline gap-1">
            <span className={cn(
              "text-xl font-light tracking-tight",
              isDark ? "text-white" : "text-red-800"
            )}>Tech</span>
          </div>
          <span className={cn(
            "text-2xl font-black tracking-tighter uppercase -mt-1",
            isDark ? "text-red-500" : "text-red-900"
          )}>Reserve</span>
          <span className={cn(
            "text-[8px] font-bold tracking-[0.2em] uppercase mt-0.5",
            isDark ? "text-slate-400" : "text-slate-500"
          )}>FATEC Solutions</span>
        </div>
      )}
    </div>
  );
}
