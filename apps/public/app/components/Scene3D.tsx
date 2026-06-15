'use client';

import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Float, Environment } from '@react-three/drei';
import * as THREE from 'three';

const CONFESSIONS = [
  "I failed my midterm but I'm still smiling.",
  "Does anyone else feel completely lost in CS301?",
  "I think I'm in love with my lab partner.",
  "Library coffee is the only thing keeping me alive.",
  "I skipped class today to sleep. No regrets.",
  "Who else is grinding LeetCode at 3 AM?",
  "I miss home cooked food so much...",
  "Imposter syndrome is hitting me hard right now.",
  "To the girl in the red hoodie, you have a beautiful smile.",
  "I just got my first internship offer! 😭",
  "I have no idea what I'm doing with my life.",
  "Is it normal to eat cereal for dinner 4 days a week?",
  "My code finally compiled and I don't know why.",
  "I spent 5 hours debugging a missing semicolon.",
  "I just want to sleep for a week straight.",
  "I pretend to take notes but I'm just playing Minesweeper.",
  "Does anyone actually read the syllabus?",
  "I'm terrified of graduating next year.",
  "I dropped a class because the walk was too far.",
  "Thank you to the person who held the door for me today."
];

function InteractiveConfession({ item }: { item: any }) {
  const groupRef = useRef<THREE.Group>(null);
  const vec = new THREE.Vector3();
  
  const basePos = useMemo(() => new THREE.Vector3(item.x, item.y, item.z), [item]);
  const currentPos = useMemo(() => new THREE.Vector3(item.x, item.y, item.z), [item]);
  const velocity = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    
    vec.copy(currentPos);
    vec.project(state.camera);
    
    const dx = vec.x - state.pointer.x;
    const dy = vec.y - state.pointer.y;
    const distance = Math.sqrt(dx * dx + (dy * dy * 1.5));
    
    if (distance < 0.4) {
      const force = (0.4 - distance) * 5;
      const angle = Math.atan2(dy, dx);
      velocity.x += Math.cos(angle) * force * delta;
      velocity.y += Math.sin(angle) * force * delta;
    }
    
    const springForce = 4.0;
    const damping = 0.85;
    
    velocity.x += (basePos.x - currentPos.x) * springForce * delta;
    velocity.y += (basePos.y - currentPos.y) * springForce * delta;
    velocity.z += (basePos.z - currentPos.z) * springForce * delta;
    
    velocity.multiplyScalar(damping);
    currentPos.add(velocity);
    groupRef.current.position.copy(currentPos);
  });

  return (
    <Float
      rotation={[item.rotX, item.rotY, item.rotZ]}
      speed={item.speed}
      rotationIntensity={0.2}
      floatIntensity={0.4}
      floatingRange={[-0.2, 0.2]}
    >
      <group ref={groupRef}>
        <Html transform center scale={item.scale} zIndexRange={[1, 0]}>
          <div className="w-[420px] bg-white shadow-xl border border-gray-100 p-5 font-sans pointer-events-none select-none text-left">
            <div className="flex items-center gap-3 mb-3">
              <div 
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: item.color }}
              >
                {item.author.charAt(0)}
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-900 text-[15px]">{item.author}</span>
                <span className="text-gray-500 text-[13px]">{item.time}</span>
              </div>
            </div>
            
            <p className="text-gray-800 text-[16px] leading-relaxed mb-4">
              {item.text}
            </p>
            
            <div className="flex items-center gap-5 text-gray-500 font-medium text-[13px]">
              <div className="flex items-center gap-2">
                <svg className="w-[18px] h-[18px]" fill="currentColor" viewBox="0 0 20 20"><path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" /></svg>
                <span>{item.likes}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg className="w-[18px] h-[18px]" fill="currentColor" viewBox="0 0 20 20"><path d="M18 9.5a1.5 1.5 0 11-3 0v-6a1.5 1.5 0 013 0v6zM14 9.667v-5.43a2 2 0 00-1.105-1.79l-.05-.025A4 4 0 0011.055 2H5.64a2 2 0 00-1.962 1.608l-1.2 6A2 2 0 004.44 12H8v4a2 2 0 002 2 1 1 0 001-1v-.667a4 4 0 01.8-2.4l1.4-1.866a4 4 0 00.8-2.4z" /></svg>
              </div>
              <span className="ml-1 uppercase tracking-wide cursor-pointer font-semibold text-gray-600">Reply</span>
            </div>
          </div>
        </Html>
      </group>
    </Float>
  );
}

function FloatingConfessions() {
  const items = useMemo(() => {
    const count = 60;
    // Generate 60 random items, picking random confessions
    const selected = Array.from({ length: count }, () => CONFESSIONS[Math.floor(Math.random() * CONFESSIONS.length)]);

    const NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Casey", "Riley", "Avery"];
    const TIMES = ["a minute ago", "3 minutes ago", "1 hour ago", "Just now", "2 hours ago", "4 hours ago"];
    const COLORS = ["#8B5CF6", "#10B981", "#06B6D4", "#F43F5E", "#F59E0B", "#6366F1"];

    return selected.map((text, i) => {
      // Arrange them in an elegant concentric ring/spiral pattern
      const angle = i * ((Math.PI * 2) / 11); // Spiral angle spread
      const radius = 4 + (i * 0.2); // Expanding outward radially
      
      const x = Math.cos(angle) * radius;
      // Squash the Y axis slightly so it fits screen aspect ratio better
      const y = Math.sin(angle) * (radius * 0.6); 
      // Stagger Z depth significantly to create a dense 3D cloud
      const z = -2 - (Math.random() * 10); 
      
      // Subtle static rotation for organic feel
      const rotX = (Math.random() - 0.5) * 0.1;
      const rotY = (Math.random() - 0.5) * 0.15;
      const rotZ = (Math.random() - 0.5) * 0.05;
      
      const speed = 0.8 + Math.random() * 1.5; // Floating bob speed

      const author = NAMES[Math.floor(Math.random() * NAMES.length)];
      const time = TIMES[Math.floor(Math.random() * TIMES.length)];
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const likes = Math.floor(Math.random() * 500) + 12;
      // Random scale between 0.18 (small) and 0.48 (large) - increased 1.5x again
      const scale = 0.18 + Math.random() * 0.30;

      return { x, y, z, rotX, rotY, rotZ, speed, text, author, time, color, likes, scale };
    });
  }, []);

  return (
    <group>
      {items.map((item, i) => (
        <InteractiveConfession key={i} item={item} />
      ))}
    </group>
  );
}

export default function Scene3D() {
  return (
    <div className="absolute inset-0 z-0">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={1.5} />
        <directionalLight position={[0, 10, 10]} intensity={1.0} color="#FFFFFF" />
        
        <FloatingConfessions />
        
        <Environment preset="city" />
      </Canvas>
    </div>
  );
}
